// 常驻服务：HTTP 控制台 + 微信长轮询 + 应用定时刷新。
//
// 一个进程三件事，刻意不拆成三个容器：
//   · 它们共享同一份内存状态（registry / sessions），拆开就要引入 IPC 或重复连接；
//   · 出问题时只有一个地方要看；
//   · 这个网关就是给一台 NAS 上的私用场景做的，不是多租户服务。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { Log, errText } from './log.js';
import { ensureDir, appendJsonl, readJsonl, trimJsonl } from './store.js';
import { Registry } from './registry.js';
import { AppStore } from './appstore.js';
import { SessionStore } from './session.js';
import { Agent } from './agent.js';
import { IlinkClient, DEFAULT_BASE } from './ilink.js';
import { checkRisk, runTool, renderResult, riskLabel } from './exec.js';
import { routeWithLLM } from './llm.js';

const VERSION = '0.2.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');

const DATA_DIR = path.resolve(process.env.GATEWAY_DATA || 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_TOKEN = process.env.GATEWAY_WEB_TOKEN || '';

ensureDir(DATA_DIR);
const log = new Log({
  level: process.env.LOG_LEVEL || 'info',
  file: path.join(DATA_DIR, 'gateway.log'),
});
const CALLS_FILE = path.join(DATA_DIR, 'calls.jsonl');
const startedAt = Date.now();

// ---- 配置 -------------------------------------------------------------

// 容器首次启动：没有配置就从示例复制一份。
// 不加这段的用户体验是「一启动就报找不到 config.json 然后退出」，
// 而在这个镜像里用户根本没有那个文件，也不知道该长什么样。
const CFG_TARGET = path.resolve(process.env.GATEWAY_CONFIG || 'config.json');
if (!fs.existsSync(CFG_TARGET)) {
  const example = path.join(HERE, '..', 'config.example.json');
  if (fs.existsSync(example)) {
    ensureDir(path.dirname(CFG_TARGET));
    fs.copyFileSync(example, CFG_TARGET);
    console.log(`[init] 没有找到配置，已从示例生成 ${CFG_TARGET}——先改 apps 里的地址和 allow_risk。`);
  }
}

const loaded = loadConfig(process.env.GATEWAY_CONFIG);
if (loaded.errors.length) {
  for (const e of loaded.errors) log.error('config', e);
  process.exit(1);
}
for (const w of loaded.warns) log.warn('config', w);

const config = loaded.config;
const appStore = new AppStore({ dataDir: DATA_DIR, baseConfig: config, log });

function applySettings() {
  const s = appStore.settings();
  config.gateway.default_app = s.default_app;
  config.gateway.confirm_risk = s.confirm_risk;
  config.gateway.confirm_ttl = s.confirm_ttl;
  config.gateway.call_timeout = s.call_timeout;
  config.gateway.async_after = s.async_after;
  config.routing.local_threshold = s.local_threshold;
  config.routing.ask_threshold = s.ask_threshold;
  config.routing.llm_when = s.llm_when;
  config.apps = appStore.resolvedApps();
  config.llm.providers = appStore.resolvedProviders();
  config.llm.default = s.llm_default || Object.keys(config.llm.providers)[0] || '';
  config.llm.enabled = s.llm_enabled === true && Object.keys(config.llm.providers).length > 0;
  return s;
}
applySettings();
log.info('config', `配置文件 ${loaded.file}，应用 ${config.apps.length} 个，AI ${config.llm.enabled ? '已启用' : '未启用'}`);

// ---- 核心对象 ---------------------------------------------------------

const registry = new Registry(config);
const sessions = new SessionStore({ log, confirmTtl: config.gateway.confirm_ttl });
const agent = new Agent({
  registry,
  config,
  sessions,
  log,
  hooks: {
    send: (chatId, text, ctx) => wechat.send(chatId, text, ctx),
    logCall: (rec) => {
      appendJsonl(CALLS_FILE, formatCall(rec));
      try { trimJsonl(CALLS_FILE, appStore.settings().log_keep || 200); } catch { /* 日志压缩失败不影响主流程 */ }
    },
  },
});

const wechat = new IlinkClient({
  dataDir: DATA_DIR,
  baseUrl: process.env.ILINK_BASE || config.wechat?.base_url || DEFAULT_BASE,
  log,
});

let lastChatId = null;

wechat.on('message', async (m) => {
  lastChatId = m.chatId;
  try {
    await agent.handle({ chatId: m.chatId, text: m.text, contextToken: m.contextToken, trigger: 'wechat' });
  } catch (e) {
    log.error('agent', `处理消息失败：${errText(e)}`);
    await wechat.send(m.chatId, `这条没处理好：${errText(e)}`, m.contextToken).catch(() => {});
  }
});

function formatCall(rec) {
  return {
    t: new Date(rec.at || Date.now()).toISOString(),
    trigger: rec.trigger || 'wechat',
    app: rec.tool?.appLabel || rec.app || '',
    appId: rec.tool?.appId || '',
    tool: rec.tool?.name || rec.tool || '',
    key: rec.tool?.key || '',
    args: rec.args || {},
    risk: rec.tool?.risk || null,
    ok: rec.ok !== false,
    ms: rec.ms || 0,
    err: rec.err || null,
    via: rec.via || null,
  };
}

// ---- 后台任务 ---------------------------------------------------------

async function bootApps() {
  const entries = await registry.refreshAll();
  for (const e of entries) {
    if (e.status === 'online') log.info('mcp', `${e.cfg.id} 在线：${e.toolCount} 个工具，协议 ${e.protocolVersion}`);
    else log.warn('mcp', `${e.cfg.id} 离线：${e.error?.kind} ${e.error?.message}`);
  }
}

// 定时刷新：每 5 分钟重拉一次 tools/list。
// 不能依赖 capabilities.listChanged——无状态实现送不出那个通知（mailnest 实测如此）。
const REFRESH_MS = Number(process.env.REFRESH_INTERVAL_MS || 5 * 60 * 1000);
setInterval(() => {
  registry.refreshAll().catch((e) => log.warn('mcp', `定时刷新失败：${errText(e)}`));
}, REFRESH_MS).unref();

// ---- HTTP -------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!WEB_TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h === `Bearer ${WEB_TOKEN}`) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(/;\s*/).some((c) => c === `gw_token=${WEB_TOKEN}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(WEB_DIR, rel);
  // 目录穿越防护：解析后必须仍在 WEB_DIR 之下
  if (!path.resolve(target).startsWith(path.resolve(WEB_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let st;
  try { st = fs.statSync(target); } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

function wechatView() {
  return wechat.statusInfo();
}

function overview() {
  const st = registry.stats();
  const s = appStore.settings();
  const calls = readJsonl(CALLS_FILE, 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayCalls = calls.filter((c) => String(c.t || '').slice(0, 10) === today);
  return {
    version: VERSION,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    wechat: wechatView(),
    apps: st.apps.map((a) => {
      const cfg = appStore.list().find((x) => x.id === a.id) || {};
      return {
        ...a,
        url: cfg.url,
        aliases: cfg.aliases || [],
        allow_risk: cfg.allow_risk || ['read'],
        hasToken: !!cfg.hasToken,
        source: cfg.source,
      };
    }),
    toolCount: st.toolCount,
    tools: registry.tools.map((t) => ({
      key: t.key, appId: t.appId, appLabel: t.appLabel, name: t.name,
      title: t.title, description: t.description, risk: t.risk,
      required: t.inputSchema?.required || [],
    })),
    settings: s,
    stats: {
      calls: calls.length,
      todayCalls: todayCalls.length,
      todayFail: todayCalls.filter((c) => c.ok === false).length,
      recv: wechat.state.recv,
      sent: wechat.state.sent,
    },
  };
}

const ROUTES = [
  ['GET', /^\/api\/state$/, () => overview()],

  ['GET', /^\/api\/apps$/, () => ({ apps: appStore.list() })],

  ['POST', /^\/api\/apps\/test$/, async (req) => {
    const body = await readBody(req);
    if (!body.url) throw new HttpError(400, '缺少地址');
    return appStore.testConnection(body, body.token);
  }],

  ['POST', /^\/api\/apps$/, async (req) => {
    const body = await readBody(req);
    const app = appStore.upsert(body, body.token);
    applySettings();
    await registry.syncApps(config.apps);
    const entry = registry.getApp(app.id);
    return {
      app,
      status: entry?.status || 'offline',
      toolCount: entry?.toolCount || 0,
      error: entry?.error || null,
    };
  }],

  ['DELETE', /^\/api\/apps\/([\w-]+)$/, async (req, m) => {
    appStore.remove(m[1]);
    registry.removeApp(m[1]);
    applySettings();
    return { ok: true };
  }],

  ['POST', /^\/api\/apps\/([\w-]+)\/refresh$/, async (req, m) => {
    const cfgApp = config.apps.find((a) => a.id === m[1]);
    if (!cfgApp) throw new HttpError(404, '没有这个应用');
    const entry = await registry.refreshApp(cfgApp);
    return { status: entry.status, toolCount: entry.toolCount, error: entry.error };
  }],

  // 从控制台手动执行一个工具。这条路径也走完整的风险与日志，
  // 因为它消耗的是一次真实调用，跟微信里发的没区别。
  ['POST', /^\/api\/exec$/, async (req) => {
    const body = await readBody(req);
    const tool = registry.find(body.key);
    if (!tool) throw new HttpError(404, '没有这个工具');
    const app = registry.getApp(tool.appId);
    const v = checkRisk(tool, app?.cfg, config.gateway);
    if (v.verdict === 'denied') throw new HttpError(403, v.reason);
    if (v.verdict === 'confirm' && body.confirm !== true) {
      return { needConfirm: true, reason: v.reason, tool: { key: tool.key, title: tool.title, risk: tool.risk } };
    }
    const res = await runTool(registry, tool, body.args || {}, (app?.cfg?.timeout || config.gateway.call_timeout) * 1000);
    const rendered = renderResult(tool, res);
    agent.hooks.logCall({ trigger: 'console', tool, args: body.args || {}, ok: !res.isError, ms: res.ms, err: res.isError ? res.text : null });
    return { ...rendered, ok: !res.isError, ms: res.ms, raw: res.data || null };
  }],

  ['GET', /^\/api\/logs/, (req, m, url) => {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 30)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const all = readJsonl(CALLS_FILE, 0).reverse();
    return { total: all.length, offset, limit, rows: all.slice(offset, offset + limit) };
  }],

  ['GET', /^\/api\/settings$/, () => ({ settings: appStore.settings() })],

  ['POST', /^\/api\/settings$/, async (req) => {
    const body = await readBody(req);
    const s = appStore.saveSettings(body);
    applySettings();
    sessions.confirmTtl = (s.confirm_ttl || 60) * 1000;
    log.info('config', `设置已更新：日志保留 ${s.log_keep} 条，AI ${s.llm_enabled ? '开' : '关'}`);
    return { settings: s };
  }],

  ['GET', /^\/api\/providers$/, () => ({ providers: appStore.providers(), settings: appStore.settings() })],

  ['POST', /^\/api\/providers$/, async (req) => {
    const body = await readBody(req);
    const p = appStore.upsertProvider(body, body.api_key);
    applySettings();
    return { provider: p };
  }],

  ['DELETE', /^\/api\/providers\/([\w-]+)$/, async (req, m) => {
    appStore.removeProvider(m[1]);
    applySettings();
    return { ok: true };
  }],

  // 真发一次请求验证 provider 能用。比"保存成功"有用得多——
  // key 错、base_url 少 /v1、模型名不存在，都只有在真调用时才暴露。
  ['POST', /^\/api\/providers\/test$/, async (req) => {
    const body = await readBody(req);
    const providers = { ...config.llm.providers };
    providers.__probe = {
      type: body.type === 'anthropic' ? 'anthropic' : 'openai',
      base_url: String(body.base_url || '').replace(/\/+$/, ''),
      model: body.model,
      api_key: body.api_key || config.llm.providers[body.id]?.api_key || '',
    };
    const probeCfg = { llm: { enabled: true, default: '__probe', timeout: 20, max_tokens: 32, providers } };
    try {
      const r = await routeWithLLM({
        text: '回一个字：好',
        tools: [{ name: 'noop', description: '什么都不做', inputSchema: { type: 'object', properties: {} } }],
        config: probeCfg,
      });
      return { ok: true, model: r.model, ms: r.ms, reply: (r.text || '').slice(0, 60) };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }],

  ['GET', /^\/api\/wechat\/status$/, () => wechatView()],

  ['POST', /^\/api\/wechat\/qr$/, async () => {
    const r = await wechat.beginLogin();
    return { ...r, status: wechatView() };
  }],

  ['POST', /^\/api\/wechat\/relogin$/, async () => {
    await wechat.logout();
    lastChatId = null;   // 新机器人对应新的会话，旧 id 不可复用
    const r = await wechat.beginLogin();
    return { ...r, status: wechatView() };
  }],

  ['POST', /^\/api\/wechat\/logout$/, async () => {
    await wechat.logout();
    lastChatId = null;
    return { status: wechatView() };
  }],

  // 给绑定的人推一条消息：验证"上行"通的唯一办法
  ['POST', /^\/api\/wechat\/push$/, async (req) => {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) throw new HttpError(400, '内容为空');
    const chatId = body.chatId || lastChatId;
    if (!chatId) throw new HttpError(400, '还没有人给机器人发过消息，不知道推给谁');
    const r = await wechat.send(chatId, text);
    if (!r.ok) throw new HttpError(502, r.error || '发送失败');
    return { ok: true, chatId };
  }],

  ['GET', /^\/api\/health$/, () => ({ ok: true, version: VERSION })],
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('bad url'); return; }

  const p = url.pathname;

  if (!p.startsWith('/api/')) {
    serveStatic(res, p);
    return;
  }

  // 这个接口必须在鉴权之前处理：前端正是靠它判断"要不要先输入令牌"
  if (p === '/api/auth') {
    sendJson(res, 200, { required: !!WEB_TOKEN, ok: authorized(req) });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: '需要访问令牌', needToken: true });
    return;
  }

  for (const [method, re, fn] of ROUTES) {
    if (req.method !== method) continue;
    const m = p.match(re);
    if (!m) continue;
    try {
      const out = await fn(req, m, url);
      sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log.error('api', `${method} ${p} → ${errText(e)}`);
      sendJson(res, status, { error: errText(e) });
    }
    return;
  }

  sendJson(res, 404, { error: '没有这个接口' });
});

// ---- 启动 -------------------------------------------------------------

async function main() {
  await bootApps();

  if (wechat.load()) {
    wechat.start().catch((e) => log.error('wechat', `上线失败：${errText(e)}`));
  } else {
    log.info('wechat', '未绑定微信，打开控制台扫码');
  }

  server.listen(PORT, HOST, () => {
    log.info('server', `控制台 http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  （v${VERSION}）`);
  });
}

async function shutdown(sig) {
  log.info('server', `收到 ${sig}，正在退出`);
  server.close();
  try { await wechat.stop(); } catch { /* 尽量优雅 */ }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('process', `未处理的 Promise 拒绝：${errText(e)}`));
process.on('uncaughtException', (e) => log.error('process', `未捕获异常：${e?.stack || e}`));

main().catch((e) => {
  log.error('server', `启动失败：${e?.stack || e}`);
  process.exit(1);
});
