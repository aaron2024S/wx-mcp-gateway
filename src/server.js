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

import { VERSION } from './version.js';
import { loadConfig } from './config.js';
import { Log, errText } from './log.js';
import { ensureDir, appendJsonl, readJsonl, trimJsonl } from './store.js';
import { Registry } from './registry.js';
import { AppStore } from './appstore.js';
import { SessionStore } from './session.js';
import { Agent } from './agent.js';
import { IlinkClient, DEFAULT_BASE } from './ilink.js';
import { checkRisk, runTool, renderResult, riskLabel } from './exec.js';
import { routeWithLLM, listModels } from './llm.js';
import { route, llmState } from './router.js';
import { formatCall } from './calllog.js';
import {
  Auth, AuthError, COOKIE_NAME, MIN_PASSWORD,
  MAX_FAILURES, TTL_KEEP_MS, lockedHint,
} from './auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');

const DATA_DIR = path.resolve(process.env.GATEWAY_DATA || 'data');
const PORT = Number(process.env.PORT || 7337);
const HOST = process.env.HOST || '0.0.0.0';

ensureDir(DATA_DIR);
const log = new Log({
  level: process.env.LOG_LEVEL || 'info',
  file: path.join(DATA_DIR, 'gateway.log'),
});
const auth = new Auth({ dataDir: DATA_DIR, log });
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
    console.log(`[init] 没有找到配置，已从示例生成 ${CFG_TARGET}——应用和 AI 服务商都在网页里添加，不用改这个文件。`);
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
  // 默认服务商可能已经被删掉了——不校验的话 llm.default 会指向一个不存在的 id，
  // 表现是"AI 开着但每次调用都报服务商不存在"。
  const provIds = Object.keys(config.llm.providers);
  config.llm.default = provIds.includes(s.llm_default) ? s.llm_default : (provIds[0] || '');
  config.llm.enabled = s.llm_enabled === true && provIds.length > 0;
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

// ---- 会话 / 客户端识别 -------------------------------------------------

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/** 是不是内网/本机地址（含 IPv4-mapped IPv6 写法）。 */
function isPrivateIP(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  if (!a) return false;
  if (a === '::1' || a === '127.0.0.1') return true;
  if (/^127\./.test(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  return false;
}

/**
 * 取客户端 IP，用于失败计数与锁定。
 *
 * 只有「直连方本身是内网/本机」时才采信 X-Forwarded-For —— 容器部署常在前面挂
 * NAS 的反向代理，那种情况下 socket 是 172.x 的网桥地址、真实来源只在 XFF 里。
 * 但如果无条件相信 XFF，攻击者每次换一个假值就能把锁定绕过去。
 */
function clientIP(req) {
  const sock = req.socket.remoteAddress || '';
  if (isPrivateIP(sock)) {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first) return first;
  }
  return sock;
}

function sessionCookie(token, keep, secure) {
  const bits = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  // 局域网 HTTP 部署下如果强加 Secure，浏览器不会回传 Cookie，等于永远登不进去。
  // 只有明确走 HTTPS（反向代理声明）时才加。
  if (secure) bits.push('Secure');
  if (keep) bits.push(`Max-Age=${Math.floor(TTL_KEEP_MS / 1000)}`);
  return bits.join('; ');
}

/** 当前请求携带的有效会话 token；没登录返回空串。 */
function currentSession(req) {
  const token = getCookie(req, COOKIE_NAME);
  return auth.validate(token) ? token : '';
}

function authState(req) {
  const ip = clientIP(req);
  const left = auth.lockedFor(ip);
  return {
    initialized: auth.initialized,
    loggedIn: Boolean(currentSession(req)),
    failures: auth.failuresFor(ip),
    maxFailures: MAX_FAILURES,
    lockedFor: left > 0 ? Math.ceil(left / 1000) : 0,
    lockedHint: left > 0 ? lockedHint(left) : '',
    minPassword: MIN_PASSWORD,
  };
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

  // 服务商支持哪些模型，让它自己报。模型名比代码过期得快，
  // 界面上的「拉取列表」走这条，别再靠预设里猜。
  ['POST', /^\/api\/providers\/models$/, async (req) => {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    try {
      const models = await listModels({
        type: body.type === 'anthropic' ? 'anthropic' : 'openai',
        base_url: body.base_url,
        api_key: body.api_key || config.llm.providers[id]?.api_key || '',
      });
      return { ok: true, models };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
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
    // 样本用真实工具：只发一个叫 noop 的假工具的话，工具名与参数 schema 的问题
    // 全被绕过去了 —— 结果是「测试连接」显示通了、一按「试一句」就 400，
    // 等于测了个假的（工具名带点号被 DeepSeek 拒就是这么漏掉的）。
    const sample = registry.llmTools();
    try {
      const r = await routeWithLLM({
        text: '回一个字：好',
        tools: sample.length
          ? sample.slice(0, 2)
          : [{ name: 'noop', description: '什么都不做', inputSchema: { type: 'object', properties: {} } }],
        config: probeCfg,
      });
      return { ok: true, model: r.model, ms: r.ms, reply: (r.text || '').slice(0, 60) };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }],

  // 全链路自检：一句真话走一遍识别层（只决定、不执行），把"到底走没走 AI、
  // 为什么没走"一次说清。用户开了「总是先问 AI」却看到日志写"本地"时，
  // 这里能直接看到是开关没开、没服务商，还是 key/model 报错。
  ['POST', /^\/api\/llm\/probe$/, async (req) => {
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 200) || '查一下我的未读邮件';
    const state = llmState(config);
    const started = Date.now();
    const d = await route(text, { registry, config });
    return {
      text,
      state,
      ms: Date.now() - started,
      kind: d.kind,
      via: d.via || null,
      tool: d.tool ? (d.tool.title || d.tool.name) : null,
      toolKey: d.tool?.key || null,
      args: d.args || null,
      provider: d.provider || null,
      model: d.model || null,
      usage: d.usage || null,
      // 没走 AI 的原因：没开 / 没服务商 / 调用报错 / AI 选了个不存在的工具
      aiError: d.aiError || (d.kind === 'menu' ? d.note || null : null),
      candidates: (d.candidates || []).slice(0, 3).map((c) => c.label),
    };
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

  // /api/health 不在这张表里：它在 createServer 开头就返回了（要在登录校验之前）
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 只在内网直连/反代声明时才认为走的是 HTTPS。 */
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

/** 认证类错误统一出口：锁定给 429 + 剩余秒数，密码错给 401，参数问题给 400。 */
function failAuth(res, e) {
  if (!(e instanceof AuthError)) {
    log.error('auth', errText(e));
    sendJson(res, 500, { error: '服务端出错了，请稍后再试' });
    return;
  }
  if (e.code === 'locked') {
    // retryAfter 让前端能起倒计时，而不是"再点一次才知道还被锁着"
    const left = e.retryAfter || 0;
    sendJson(res, 429, { error: e.message, code: 'locked', retryAfter: left });
    return;
  }
  const status = e.code === 'bad_password' ? 401 : e.code === 'already_initialized' ? 409 : 400;
  sendJson(res, status, { error: e.message, code: e.code });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('bad url'); return; }

  const p = url.pathname;

  // ---- 静态页面 ----
  if (!p.startsWith('/api/')) {
    // 标签页图标必须免登录：登录页本身就是"没有会话"的状态，图标要是被
    // 302 到 /login，浏览器拿到的是 HTML，标签栏照样空白。只白名单这一个
    // 路径，别顺手把整个静态目录放开。
    if (p === '/favicon.svg' || p === '/favicon.ico') {
      serveStatic(res, '/favicon.svg');
      return;
    }
    if (p === '/login' || p === '/login.html') {
      if (currentSession(req)) { res.writeHead(302, { Location: '/' }).end(); return; }
      serveStatic(res, '/login.html');
      return;
    }
    // 未登录统一甩到登录页。用 302 而不是直接吐登录页内容：地址栏能看出
    // "我是被踢出来的"，登录完再回跳也不会莫名其妙停在一个陌生 URL 上。
    if (!currentSession(req)) {
      res.writeHead(302, { Location: '/login' }).end();
      return;
    }
    serveStatic(res, p);
    return;
  }

  // ---- 认证接口：必须在登录校验之前，否则没人能登进来 ----
  // 健康检查也在这里：容器的 HEALTHCHECK 用它，而容器里没有会话；
  // 放到后面会让容器永远 unhealthy。
  if (p === '/api/health') {
    sendJson(res, 200, { ok: true, version: VERSION });
    return;
  }

  if (p === '/api/auth/session') {
    sendJson(res, 200, authState(req));
    return;
  }

  if (p === '/api/auth/setup' && req.method === 'POST') {
    const ip = clientIP(req);
    const left = auth.lockedFor(ip);
    if (left > 0) {
      sendJson(res, 429, { error: lockedHint(left), code: 'locked', retryAfter: Math.ceil(left / 1000) });
      return;
    }
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = await auth.setup(String(body.password ?? ''), String(body.confirm ?? ''), ip, req.headers['user-agent'] || '');
      // 首启自动登录下发**会话 Cookie**（不带 Max-Age）：关掉浏览器就失效，
      // 不悄悄留下一个 7 天的持久登录。
      res.setHeader('Set-Cookie', sessionCookie(r.token, false, isHttps(req)));
      sendJson(res, 200, { ok: true, autoLogin: true });
    } catch (e) {
      failAuth(res, e);
    }
    return;
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIP(req);
    const body = await readBody(req).catch(() => ({}));
    try {
      const r = await auth.login(String(body.password ?? ''), ip, req.headers['user-agent'] || '', body.keep === true);
      res.setHeader('Set-Cookie', sessionCookie(r.token, r.keep, isHttps(req)));
      sendJson(res, 200, { ok: true, expiresIn: Math.floor(r.ttl / 1000) });
    } catch (e) {
      const left = auth.lockedFor(ip);
      if (e instanceof AuthError && e.code === 'locked') e.retryAfter = Math.ceil(left / 1000);
      failAuth(res, e);
    }
    return;
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(getCookie(req, COOKIE_NAME));
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === '/api/auth/password' && req.method === 'POST') {
    if (!currentSession(req)) { sendJson(res, 401, { error: '请先登录', needLogin: true }); return; }
    const body = await readBody(req).catch(() => ({}));
    try {
      await auth.changePassword(String(body.oldPassword ?? ''), String(body.newPassword ?? ''), String(body.confirm ?? ''));
      // 改密后所有会话作废，当前这个也不例外——清掉 Cookie 让前端回登录页
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      sendJson(res, 200, { ok: true, relogin: true });
    } catch (e) {
      // 这里不能用 failAuth：它把「密码错」映射成 401，而前端把 401 一律当作
      // 会话失效直接跳登录页。用户只是打错了原密码，不该被踢出去。
      if (e instanceof AuthError) {
        sendJson(res, 400, { error: e.message, code: e.code });
      } else {
        log.error('auth', errText(e));
        sendJson(res, 500, { error: '服务端出错了，请稍后再试' });
      }
    }
    return;
  }

  // ---- 其余接口一律要求登录 ----
  if (!currentSession(req)) {
    sendJson(res, 401, { error: '请先登录', needLogin: true });
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
    if (!auth.initialized) {
      log.warn('server', '还没设置访问密码：打开控制台会先要求设一个，之后用它登录');
    }
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
