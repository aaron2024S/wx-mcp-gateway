// 一键验证：拉起一个临时 MailNest 实例 → 拉 tools/list → 建索引 → 跑几条中文句子
// 用法：npm run demo
//
// 这一步完全不涉及微信，只验证「网关能不能连上任意 MCP server，并把中文映射成工具」。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { route, renderMenu } from '../src/router.js';

const MAILBOX = 'D:/workbuddy/mailbox';
const PORT = Number(process.env.DEMO_PORT || 3381);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('.demo-data');
const CFG = path.resolve('.demo-config.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) => {
  // 中文字符宽度按 2 算，保证输出对齐
  const w = [...String(s)].reduce((a, c) => a + (/[\u4e00-\u9fff]/.test(c) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

let child = null;
function cleanup() {
  try { if (child && !child.killed) child.kill(); } catch { /* 已退出 */ }
}
process.on('exit', cleanup);

async function waitReady(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/setup-status');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function api(method, p, body, cookie) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MailNest',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let cookieOut = cookie;
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    if (kv.startsWith('mn_session=')) cookieOut = kv;
  }
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data, cookie: cookieOut };
}

async function main() {
  console.log('启动临时 MailNest……');
  fs.rmSync(DATA, { recursive: true, force: true });
  let ready = false;
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: MAILBOX,
      env: { ...process.env, PORT: String(PORT), MAILNEST_DATA: DATA },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    ready = await waitReady(attempt === 1 ? 30000 : 15000);
    if (!ready) { cleanup(); await sleep(500); }
  }
  if (!ready) throw new Error('MailNest 起不来（端口被占？）');

  // 建管理员 + 发令牌
  let r = await api('POST', '/api/setup', { username: 'admin', password: 'password123' }, '');
  let cookie = r.cookie;
  r = await api('POST', '/api/agent/tokens', { name: 'demo', scopes: ['read', 'write', 'send'], expiresInDays: 30 }, cookie);
  const token = r.data?.token;
  if (!token) throw new Error('拿不到令牌：' + JSON.stringify(r.data));
  console.log('令牌已生成：' + token.slice(0, 18) + '…\n');

  // 写一份配置：故意只手工补两条别名，其余全靠自动派生
  const cfgObj = {
    gateway: { confirm_risk: ['high'], call_timeout: 20 },
    routing: { local_threshold: 0.5, ask_threshold: 0.25, llm_when: 'miss' },
    llm: { enabled: false, providers: {} },
    apps: [{
      id: 'mail',
      label: '邮箱',
      aliases: ['邮件', '信箱'],
      transport: 'mcp-http',
      url: `${BASE}/mcp`,
      auth: { type: 'bearer', token },
      allow_risk: ['read', 'write', 'send'],
      tools: {
        aliases: {
          list_messages: ['未读'],
          read_message: ['看正文'],
        },
        risk_overrides: { delete_messages: 'high', send_message: 'high' },
      },
    }],
  };
  fs.writeFileSync(CFG, JSON.stringify(cfgObj, null, 2), 'utf8');

  const { config, errors, warns } = loadConfig(CFG);
  if (errors.length) throw new Error('配置错误：' + errors.join('；'));
  for (const w of warns) console.log('⚠ ' + w);

  const registry = new Registry(config);
  const entries = await registry.refreshAll();

  console.log('\n=== 应用状态 ===');
  for (const e of entries) {
    if (e.status === 'online') {
      console.log(`  ${pad(e.cfg.id, 10)}在线   协议 ${e.protocolVersion}   工具 ${e.toolCount} 个   ` +
        `${e.serverInfo?.name || ''} ${e.serverInfo?.version || ''}`);
    } else {
      console.log(`  ${pad(e.cfg.id, 10)}离线   ${e.error?.kind}: ${e.error?.message}`);
    }
  }

  const manual = Object.values(cfgObj.apps[0].tools.aliases).flat().length;
  console.log(`\n=== 索引 ===\n  工具 ${registry.tools.length} 个，全部由 tools/list 自动派生；` +
    `配置里人工只补了 ${manual} 条别名。`);

  console.log('\n=== 中文匹配（纯本地，未接 AI）===');
  const queries = [
    '查一下未读',
    '收件箱有什么',
    '有哪些邮箱',
    '看看文件夹',
    '搜一下发票',
    '给 a@b.com 发个邮件',
    '把这封删了',
    '邮件 未读',
    '帮我看看箱子',
    '今天天气怎么样',
  ];
  for (const q of queries) {
    const m = registry.match(q);
    const top = m.candidates.slice(0, 2)
      .map((c) => `${c.tool.key} ${c.score.toFixed(2)}`)
      .join('  ');
    const flag = m.confident ? '直接执行' : m.understood ? '回菜单问' : '没听懂';
    console.log(`  ${pad('「' + q + '」', 22)}→ ${pad(flag, 8)}${top || '（无候选）'}`);
  }

  console.log('\n=== 走一遍完整决定 ===');
  for (const q of ['查一下未读', '今天天气怎么样']) {
    const d = await route(q, { registry, config });
    if (d.kind === 'call') {
      console.log(`  「${q}」→ 调用 ${d.tool.key}（via ${d.via}，分数 ${d.score?.toFixed(2)}）`);
    } else if (d.kind === 'menu') {
      console.log(`  「${q}」→ 回菜单：`);
      console.log(renderMenu(d.candidates.slice(0, 4), d.note).split('\n').map((l) => '      ' + l).join('\n'));
    } else {
      console.log(`  「${q}」→ ${d.kind}: ${d.text || d.error || ''}`);
    }
  }

  console.log('\n=== 真正执行一次工具调用 ===');
  const target = registry.find('mail.list_accounts');
  if (!target) throw new Error('索引里找不到 list_accounts');
  const entry = registry.getApp(target.appId);
  const res = await entry.client.callTool(target.name, {});
  console.log(`  ${target.key} → ${res.ms} ms, isError=${res.isError}`);
  console.log('  返回：' + res.text.replace(/\n/g, ' ').slice(0, 160));

  console.log('\n全部通过。加新应用只需要在 config.json 的 apps 里加一段，代码不用动。');
}

main()
  .catch((e) => { console.error('\n失败：' + (e?.stack || e)); process.exitCode = 1; })
  .finally(async () => {
    cleanup();
    await sleep(400);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
    try { fs.rmSync(CFG, { force: true }); } catch { /* 忽略 */ }
  });
