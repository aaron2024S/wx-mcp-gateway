// 端到端验证：假 iLink 网关 + 假 MCP server，把整条链路真跑一遍。
//
// 为什么必须做这个而不是"看看代码对不对"：
//   iLink 的字段名、请求头、错误码全都无法从公开文档核对，写错一个字母的表现
//   是"消息不进来"——在真机上这要等到用户扫码绑定之后才会发现，而且很难定位。
//   这里用假网关把所有字段固定下来，改坏了立刻红。
//
// 覆盖：
//   ① 扫码 → confirmed → notifystart → 长轮询 全流程
//   ② 请求头与 base_info 逐字段校验
//   ③ 收消息 → 本地匹配 → 执行工具 → 发回复（含返回内容渲染）
//   ④ 高危操作二次确认（未确认不执行）
//   ⑤ 同一消息重投只处理一次
//   ⑥ -14 转 needs_relogin，且清掉落盘凭据

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';

import { IlinkClient, qrSvg } from '../src/ilink.js';
import { Registry } from '../src/registry.js';
import { SessionStore } from '../src/session.js';
import { Agent } from '../src/agent.js';
import { Log } from '../src/log.js';
import { renderResult } from '../src/exec.js';
import { formatCall } from '../src/calllog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
};

// 假 MCP 的能力清单。往 EXTRA_TOOLS 里塞一条，就能模拟「应用侧更新了能力」。
const EXTRA_TOOLS = [];
const BASE_TOOLS = [
  {
    name: 'status',
    title: '查看状态',
    description: '查询当前状态概览',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_messages',
    title: '列出邮件',
    description: '按时间倒序列出邮件摘要，含发件人、主题、时间',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_message',
    title: '发送邮件',
    description: '向指定收件人发送邮件',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: '收件人邮箱' }, subject: { type: 'string', description: '主题' }, text: { type: 'string', description: '正文' } },
      required: ['to', 'subject', 'text'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'reboot',
    title: '重启路由器',
    description: '重启设备，网络会中断',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
];

// ---- 假 MCP server ----------------------------------------------------

const calls = [];   // 收到的 tools/call

function mockMcp() {
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const body = JSON.parse(buf || '{}');
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize') {
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fake-mail', version: '9.9.9' },
        });
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(200).end('{}');
        return;
      }
      if (body.method === 'tools/list') {
        return reply({ tools: [...BASE_TOOLS, ...EXTRA_TOOLS] });
      }
      if (body.method === 'tools/call') {
        const { name, arguments: args } = body.params;
        calls.push({ name, args });
        if (name === 'status') {
          return reply({ content: [{ type: 'text', text: '一切正常，在线 6 台设备' }] });
        }
        if (name === 'list_messages') {
          return reply({
            content: [{
              type: 'text',
              text: JSON.stringify({
                total: 3,
                messages: [
                  { uid: 101, subject: '合同确认', from: { name: '张三' }, date: '昨天', seen: false },
                  { uid: 102, subject: '报价单', from: { name: '李四' }, date: '前天', seen: true },
                  { uid: 103, subject: '周会纪要', from: { name: '王五' }, date: '3 天前', seen: true },
                ],
              }),
            }],
          });
        }
        return reply({ content: [{ type: 'text', text: `已执行 ${name}` }] });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---- 假 iLink 网关 ----------------------------------------------------

function mockIlink() {
  const seen = {
    headers: [],
    bodies: [],
    sends: [],
    qrPolls: 0,
  };
  let queue = [];
  let mode = 'normal';   // normal | invalid

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const body = JSON.parse(buf || '{}');
      seen.headers.push({ path: url.pathname, ...req.headers });
      seen.bodies.push({ path: url.pathname, body });

      const json = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };

      if (url.pathname === '/ilink/bot/get_bot_qrcode') {
        return json({ qrcode: 'QR-ABC', qrcode_img_content: 'https://weixin.qq.com/scan/QR-ABC' });
      }
      if (url.pathname === '/ilink/bot/get_qrcode_status') {
        seen.qrPolls++;
        if (seen.qrPolls === 1) return json({ status: 'wait' });
        return json({ status: 'confirmed', bot_token: 'BOT-TOKEN-1', baseurl: `http://127.0.0.1:${server.address().port}`, ilink_bot_id: 'bot_42' });
      }
      if (url.pathname === '/ilink/bot/msg/notifystart' || url.pathname === '/ilink/bot/msg/notifystop') {
        return json({ ret: 0 });
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        if (mode === 'invalid') return json({ errcode: -14 });
        if (queue.length) {
          const msgs = queue;
          queue = [];
          return json({ ret: 0, get_updates_buf: 'BUF-' + Date.now(), msgs });
        }
        await sleep(120);
        return json({ ret: 0, get_updates_buf: 'BUF-EMPTY', msgs: [] });
      }
      if (url.pathname === '/ilink/bot/sendmessage') {
        seen.sends.push(body);
        return json({ ret: 0 });
      }
      res.writeHead(404).end('{}');
    });
  });

  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    server,
    seen,
    push: (m) => queue.push(m),
    setMode: (m) => { mode = m; },
    get port() { return server.address().port; },
  })));
}

// ---- 假 AI 端点（OpenAI 兼容）----------------------------------------
// 只为了让「via=llm + token 用量」这条路径能被真正跑一遍：
// 不接真 API，也就不会因为没 key 而让这一段永远没人测。

function mockLlm() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(buf || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_messages', arguments: '{}' } }],
          },
        }],
        usage: { prompt_tokens: 812, completion_tokens: 43, total_tokens: 855 },
      }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}/v1`,
  })));
}

// ---- 主流程 -----------------------------------------------------------

async function main() {
  const mcp = await mockMcp();
  const il = await mockIlink();
  const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
  const ilBase = `http://127.0.0.1:${il.port}`;
  const dataDir = path.join(os.tmpdir(), 'wxgw-e2e-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });

  const log = new Log({ level: 'error', buffer: 50 });
  const config = {
    gateway: { default_app: null, confirm_risk: ['high'], confirm_ttl: 60, call_timeout: 15, async_after: 5 },
    routing: { local_threshold: 0.5, ask_threshold: 0.25, llm_when: 'never' },
    llm: { enabled: false, providers: {} },
    apps: [{
      id: 'mail', label: '邮箱', aliases: ['邮件'],
      transport: 'mcp-http', url: mcpUrl,
      auth: { token: '' },
      allow_risk: ['read', 'write', 'high'],   // 放开 high 才能测到「确认」这一层；
                                               // 不放开时会被网关硬上限直接拦掉（另一条断言会覆盖）
      tools: { aliases: { list_messages: ['未读'] } },
    }],
  };

  const registry = new Registry(config);
  await registry.refreshAll();
  const sessions = new SessionStore({ log, confirmTtl: 60 });

  const wechat = new IlinkClient({ dataDir, baseUrl: ilBase, log });
  const outbox = [];
  const logged = [];   // agent 落盘前的原始记录，用来验「谁认的 + 花了多少 token」
  const agent = new Agent({
    registry, config, sessions, log,
    hooks: {
      send: async (chatId, text, ctx) => { outbox.push(text); await wechat.send(chatId, text, ctx); },
      logCall: (rec) => logged.push(rec),
    },
  });
  wechat.on('message', (m) => agent.handle({ chatId: m.chatId, text: m.text, contextToken: m.contextToken, trigger: 'wechat' }));

  console.log('\n=== ① 应用连接 ===');
  ok('假 MCP 已连上', registry.stats().apps[0].status === 'online');
  ok('4 个工具入库', registry.tools.length === 4, JSON.stringify(registry.tools.map((t) => t.name)));

  console.log('\n=== ② 扫码绑定 ===');
  const qr = await wechat.beginLogin();
  ok('拿到二维码标识', qr.code === 'QR-ABC');
  ok('二维码渲染成 SVG', String(qr.svg).startsWith('<svg') && qr.svg.includes('<path'));
  ok('qrSvg 尺寸合理', qrSvg('https://x.y/z').includes('width="'));

  // 轮询是后台的，等它走完 wait → confirmed
  for (let i = 0; i < 50 && wechat.state.status !== 'online'; i++) await sleep(100);
  ok('已上线', wechat.state.status === 'online', wechat.state.status);
  ok('bot_id 已记录', wechat.state.botId === 'bot_42');
  ok('token 已保存到磁盘', JSON.parse(fs.readFileSync(path.join(dataDir, 'weixin.json'), 'utf8')).token === 'BOT-TOKEN-1');

  // 「已上线」在 start() 里是同步置位的，但长轮询的第一轮 getupdates 是异步发的。
  // 不等这一发就先断言请求头，会偶发地 8 条一起红（机器慢或 CI 上更容易踩）。
  for (let i = 0; i < 50 && !il.seen.headers.some((x) => x.path === '/ilink/bot/getupdates'); i++) await sleep(100);

  const h = il.seen.headers.find((x) => x.path === '/ilink/bot/getupdates');
  ok('请求头 AuthorizationType', h?.authorizationtype === 'ilink_bot_token');
  ok('请求头 iLink-App-Id', h?.['ilink-app-id'] === 'bot');
  ok('请求头 ClientVersion', h?.['ilink-app-clientversion'] === '65547');
  ok('请求头 Authorization Bearer', h?.authorization === 'Bearer BOT-TOKEN-1');
  ok('请求头 X-WECHAT-UIN 是数字', /^\d+$/.test(h?.['x-wechat-uin'] || ''));

  const b = il.seen.bodies.find((x) => x.path === '/ilink/bot/getupdates');
  ok('body 有 get_updates_buf', typeof b?.body.get_updates_buf === 'string');
  ok('body 有 base_info.channel_version', !!b?.body.base_info?.channel_version);
  ok('body 有 base_info.bot_agent', !!b?.body.base_info?.bot_agent);

  console.log('\n=== ③ 一句话 → 工具 → 回复 ===');
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-1', msg_id: 'm1', item_list: [{ type: 1, text_item: { text: '邮箱 状态' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('回了话', outbox.length === 1, JSON.stringify(outbox));
  ok('回复内容正确', /一切正常/.test(outbox[0] || ''), outbox[0]);
  const sent = il.seen.sends.at(-1);
  ok('发消息带 context_token', sent?.msg?.context_token === 'CTX-1');
  ok('发消息 to_user_id 正确', sent?.msg?.to_user_id === 'wxid_me');
  ok('发消息 message_type=2', sent?.msg?.message_type === 2);
  ok('发消息 item 是文本', sent?.msg?.item_list?.[0]?.type === 1);

  console.log('\n=== ④ 列表渲染 ===');
  outbox.length = 0;
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-2', msg_id: 'm2', item_list: [{ type: 1, text_item: { text: '查一下未读' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('列表被列表化', /共 3 条/.test(outbox[0] || ''), outbox[0]);
  ok('条目带发件人与未读标记', /张三/.test(outbox[0] || '') && /未读/.test(outbox[0] || ''), outbox[0]);

  console.log('\n=== ④b 帮助文案按真实工具生成 ===');
  // 出厂不带应用，接进来的可能是路由器、下载器，帮助里写死「看有哪些邮箱」
  // 会让人以为功能不存在。例子必须来自当前 tools/list。
  outbox.length = 0;
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-H', msg_id: 'mH', item_list: [{ type: 1, text_item: { text: '/help' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  const help = outbox[0] || '';
  ok('例子来自真实工具', /列出邮件|搜索邮件|列出邮箱账号/.test(help), help);
  ok('不再写死邮箱示例', !/看有哪些邮箱/.test(help), help);
  ok('指令清单一并给出', /\/menu/.test(help) && /\/status/.test(help), help);

  console.log('\n=== ④c 应用侧更新能力，这边不用重新添加 ===');
  // 后台每 5 分钟跑一次 refreshAll，这里手动跑一次等价于等它到点。
  EXTRA_TOOLS.push({
    name: 'archive_message',
    title: '归档邮件',
    description: '把邮件从收件箱移到归档',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  });
  await registry.refreshAll();
  let avail = registry.stats().apps[0].available || [];
  ok('刷新后能拉到新工具', avail.some((t) => t.name === 'archive_message'), JSON.stringify(avail.map((t) => t.name)));
  ok('没设白名单时新工具直接生效', registry.tools.some((t) => t.name === 'archive_message'));

  // 反过来：设了 include 白名单，新工具会被挡住——但必须仍然出现在 available 里，
  // 否则编辑页看不到它，用户永远没机会把它勾上。
  const mailApp = registry.getApp('mail').cfg;
  mailApp.tools = { include: ['status'] };
  await registry.refreshAll();
  avail = registry.stats().apps[0].available || [];
  const fresh = avail.find((t) => t.name === 'archive_message');
  ok('白名单外的新工具仍出现在全量清单里', !!fresh);
  ok('并标注为未启用', fresh?.enabled === false);
  ok('索引里确实没有它', !registry.tools.some((t) => t.name === 'archive_message'));

  // 复原，别影响后面几条用例
  mailApp.tools = {};
  EXTRA_TOOLS.length = 0;
  await registry.refreshAll();
  ok('复原后回到 4 个工具', registry.tools.length === 4, JSON.stringify(registry.tools.map((t) => t.name)));

  console.log('\n=== ④d 主题三态：跟随系统 / 浅色 / 深色 ===');
  {
    const read = (p) => fs.readFileSync(new URL(`../src/web/${p}`, import.meta.url), 'utf8');
    const html = read('index.html');
    const js = read('app.js');
    const modes = [...html.matchAll(/data-theme-mode="([a-z]+)"/g)].map((m) => m[1]);
    ok('面板上有三个档位', modes.length === 3 && ['auto', 'light', 'dark'].every((m) => modes.includes(m)), modes.join(','));
    ok('每档都配了图标', (html.match(/seg-btn[\s\S]*?<svg/g) || []).length >= 3);
    ok('缺省是跟随系统', js.includes("|| 'auto'") && js.includes("THEME_KEY = 'gw_theme_mode'"));
    ok('系统明暗变化能实时跟随', js.includes('prefers-color-scheme') && js.includes('addEventListener'));
    ok('老用户只存过 gw_theme 也能迁移', js.includes("removeItem('gw_theme')"));
  }

  console.log('\n=== ④e 标题「读」「删」这类单字不再抢路由 ===');
  {
    // 真实事故：用户问「有几封未读邮件」，本地索引把 title「读取附件内容」的首字「读」
    // 当成动作词硬命中（0.82 > 阈值），于是去调 read_attachment、回头要 uid。
    // 这里用一组最小工具复现那条路径，钉住修复。
    const rr = new Registry({ routing: { local_threshold: 0.5, ask_threshold: 0.25 }, apps: [] });
    rr.apps.set('mail', {
      cfg: { id: 'mail', label: '邮箱' },
      status: 'online',
      rawTools: [
        { name: 'read_attachment', title: '读取附件内容', description: '读取一封邮件里某个附件的内容', annotations: { readOnlyHint: true } },
        { name: 'read_message', title: '读取邮件正文', description: '读取一封邮件的正文', annotations: { readOnlyHint: true } },
        { name: 'unread_count', title: '查询未读数量', description: '查有多少封未读邮件', annotations: { readOnlyHint: true } },
      ],
    });
    rr._build();

    const m1 = rr.match('有几封未读邮件');
    ok('问未读数不再落到「读附件」', m1.best?.tool.name !== 'read_attachment', m1.best?.tool.key);
    ok('而是落到未读相关的工具', m1.best?.tool.name === 'unread_count', m1.best?.tool.key);

    const m2 = rr.match('读取附件');
    ok('真要读附件时仍然命中', m2.best?.tool.name === 'read_attachment' && m2.confident, `${m2.best?.tool.key} / ${m2.best?.score?.toFixed(2)}`);

    // 单字别名不再进索引：句子里出现「读」「删」这种字不足以把工具顶成 confident
    const singles = rr.tools.flatMap((t) => t.derived.filter((a) => a.length < 2));
    ok('标题不再派生出单字别名', singles.length === 0, singles.join(','));
  }

  console.log('\n=== ④f 平局窗口收紧 + 未读数不再被渲染丢掉 ===');
  {
    // 真实事故：mailnest 上问「有没有末读邮件」，unread_count 0.58 最高、
    // list_accounts 0.537 次之，但"分数差 ≤0.05 只读优先"的规则把 0.043 的
    // 真实差距当平局，按字典序让 list_accounts 抢先；它的返回值里明明带着
    // 各账号未读数，渲染时又被 itemLine 丢掉，用户看到一列光秃秃的账号名。
    //
    // 这里构造一个确定性复刻：两个只读工具 token 集合完全一致，唯一差别是
    // 「未读」在 zzz 是 title（权重 1.6）、在 aaa 只在 description（1.0），
    // 用一长串共享词把差距稀释到 0.044 —— 落在旧窗口 (0,0.05] 内、新窗口外。
    const extra = Array.from({ length: 44 }, (_, i) =>
      '词' + String.fromCharCode(0x4e00 + i * 2) + String.fromCharCode(0x4e01 + i * 2)).join(' ');
    const desc = '未读 摘要 附件 大小 日期 发件 收件 状态 ' + extra;
    const rr = new Registry({ routing: { local_threshold: 0.5, ask_threshold: 0.25 }, apps: [] });
    rr.apps.set('mail', {
      cfg: { id: 'mail', label: '邮箱' },
      status: 'online',
      rawTools: [
        { name: 'aaa_list', title: '列出邮件', description: desc, annotations: { readOnlyHint: true } },
        { name: 'zzz_list', title: '列出未读邮件', description: desc, annotations: { readOnlyHint: true } },
      ],
    });
    rr._build();
    const m = rr.match('列出未读邮件 ' + extra);
    ok('分数差超过 2 个点就按分数来，不再让字典序翻盘', m.best?.tool.name === 'zzz_list', `${m.best?.tool.key} / ${m.best?.score?.toFixed(3)}`);

    // 渲染层：数字型 unread 要显示出来，0 则不标
    const out = renderResult(
      { name: 'list_accounts', title: '列出邮箱账号' },
      { isError: false, text: '', data: { accounts: [
        { id: 'qq', email: 'a@qq.com', name: 'QQ邮箱', unread: 5 },
        { id: 'n163', email: 'b@163.com', name: '163邮箱', unread: 0 },
      ] } },
    );
    ok('列表行带出未读数', out.text.includes('未读 5'), out.text.split('\n')[1]);
    ok('未读为 0 的账号不标未读', !out.text.includes('未读 0'), out.text.split('\n')[2]);
  }

  console.log('\n=== ④g 日志要看得出「是不是 AI 认的」和花了多少 token ===');
  {
    // 用户要的是这两列的**准确性**：本地命中要标本地且不编造 token，
    // AI 命中要带服务商/模型/用量。所以这里让整条链路真跑一遍。
    const localRec = logged.find((x) => x.via === 'local');
    const localRow = formatCall(localRec || {});
    ok('本地命中记为 via=local', localRow.via === 'local', String(localRow.via));
    ok('本地命中不带 token（是空，不是 0）', localRow.tok === null && localRow.tokIn === null, JSON.stringify(localRow));

    const llm = await mockLlm();
    config.llm = {
      enabled: true, default: 'mock', timeout: 5, max_tokens: 128,
      providers: { mock: { type: 'openai', base_url: llm.url, model: 'deepseek-flash', api_key: 'k' } },
    };
    config.routing.llm_when = 'miss';

    outbox.length = 0;
    il.push({ from_user_id: 'wxid_me', context_token: 'CTX-L', msg_id: 'mL', item_list: [{ type: 1, text_item: { text: '那个东西现在怎么样了' } }] });
    for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);

    ok('本地没听懂时确实问了 AI', llm.seen.length === 1, `${llm.seen.length} 次`);
    const rec = logged.at(-1);
    ok('AI 选中的调用记为 via=llm', rec?.via === 'llm', String(rec?.via));
    ok('带上服务商与模型', rec?.provider === 'mock' && rec?.model === 'deepseek-flash', `${rec?.provider}/${rec?.model}`);
    ok('带上 token 用量（input/output/total 已统一）',
      rec?.usage?.input === 812 && rec?.usage?.output === 43 && rec?.usage?.total === 855,
      JSON.stringify(rec?.usage));

    const row = formatCall(rec || {});
    ok('落盘记录带 token 三件套', row.tokIn === 812 && row.tokOut === 43 && row.tok === 855, JSON.stringify(row));

    // 还原，别把 AI 开着影响后面几条
    config.llm = { enabled: false, providers: {} };
    config.routing.llm_when = 'never';
    llm.server.close();
  }

  console.log('\n=== ④h 两个页面都要有标签页图标 ===');
  {
    // 浏览器标签栏没图标时是"未认领的页面"，看着像半成品；而且很容易只给
    // index.html 加、忘了 login.html——登录页恰恰是用户看到的第一屏。
    const read = (p) => fs.readFileSync(new URL(`../src/web/${p}`, import.meta.url), 'utf8');
    const icon = read('favicon.svg');
    ok('favicon.svg 存在且是 32 格矢量', /viewBox="0 0 32 32"/.test(icon));
    ok('图标是品牌蓝底 + 三条白线（与侧边栏同一个标）',
      /#5B8CFF/.test(icon) && /#2F6BEE/.test(icon) && (icon.match(/stroke="#fff"/g) || []).length === 1);
    for (const page of ['index.html', 'login.html']) {
      ok(`${page} 引用了图标`, /rel="icon"[^>]*favicon\.svg/.test(read(page)), page);
      ok(`${page} 的品牌标识仍是原来那个`, /M2\.5 4\.2h11/.test(read(page)), page);
    }
  }

  console.log('\n=== ⑤ 重投去重 ===');
  outbox.length = 0;
  calls.length = 0;
  const dup = { from_user_id: 'wxid_me', context_token: 'CTX-2', msg_id: 'm2', item_list: [{ type: 1, text_item: { text: '查一下未读' } }] };
  il.push(dup); il.push(dup);
  await sleep(700);
  ok('重复消息只处理一次', calls.length === 0 && outbox.length === 0, `calls=${calls.length} outbox=${outbox.length}`);

  console.log('\n=== ⑥ 网关硬上限（不信应用自报的风险）===');
  // 把应用的开放范围收紧到只读：reboot 自报 high，应被网关侧直接拒绝，
  // 而不是"因为应用说了是 high 所以要求确认"。这是双保险里网关那一层。
  const mailCfg = registry.getApp('mail').cfg;
  mailCfg.allow_risk = ['read'];
  outbox.length = 0;
  calls.length = 0;
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-A', msg_id: 'mA', item_list: [{ type: 1, text_item: { text: '重启' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('被网关拦下并说明原因', /只开放/.test(outbox[0] || ''), outbox[0]);
  ok('确实没执行', !calls.some((c) => c.name === 'reboot'));
  mailCfg.allow_risk = ['read', 'write', 'high'];

  console.log('\n=== ⑦ 高危二次确认 ===');
  outbox.length = 0;
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-3', msg_id: 'm3', item_list: [{ type: 1, text_item: { text: '重启' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('先回确认提示', /确认/.test(outbox[0] || ''), outbox[0]);
  ok('未确认时不执行', !calls.some((c) => c.name === 'reboot'));

  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-4', msg_id: 'm4', item_list: [{ type: 1, text_item: { text: '确认' } }] });
  for (let i = 0; i < 40 && outbox.length < 2; i++) await sleep(100);
  ok('确认后执行了', calls.some((c) => c.name === 'reboot'), JSON.stringify(calls));

  console.log('\n=== ⑧ 缺参数追问 ===');
  outbox.length = 0;
  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-5', msg_id: 'm5', item_list: [{ type: 1, text_item: { text: '发送邮件' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('追问第一个缺失参数', /收件人/.test(outbox[0] || ''), outbox[0]);

  il.push({ from_user_id: 'wxid_me', context_token: 'CTX-6', msg_id: 'm6', item_list: [{ type: 1, text_item: { text: 'a@b.com' } }] });
  for (let i = 0; i < 40 && outbox.length < 2; i++) await sleep(100);
  ok('收了参数后继续问下一个', /主题/.test(outbox[1] || ''), outbox[1]);

  console.log('\n=== ⑨ -14 会话失效 ===');
  il.setMode('invalid');
  for (let i = 0; i < 60 && wechat.state.status !== 'needs_relogin'; i++) await sleep(100);
  ok('转为 needs_relogin', wechat.state.status === 'needs_relogin', wechat.state.status);
  ok('落盘凭据已清空', !JSON.parse(fs.readFileSync(path.join(dataDir, 'weixin.json'), 'utf8')).token);

  // 解绑后必须能重新扫回来：logout/_invalidate 都会把停止标志置 true，
  // 若重扫时没复位，扫码轮询和长轮询第一轮就退出，界面停在"等待扫码"永远不上线
  console.log('\n=== ⑩ 解绑 → 重扫 ===');
  il.setMode('normal');   // 关掉 -14，否则重扫后会立刻再次失效
  await wechat.logout();
  ok('解绑后回到 idle', wechat.state.status === 'idle', wechat.state.status);
  ok('解绑后内存凭据清空', !wechat.state.token && !wechat.state.botId);
  ok('解绑后落盘凭据清空', !JSON.parse(fs.readFileSync(path.join(dataDir, 'weixin.json'), 'utf8')).token);

  const qr2 = await wechat.beginLogin();
  ok('能重新生成二维码', qr2.code === 'QR-ABC' && wechat.state.status === 'scanning', wechat.state.status);
  for (let i = 0; i < 60 && wechat.state.status !== 'online'; i++) await sleep(100);
  ok('重扫后重新上线', wechat.state.status === 'online', wechat.state.status);
  ok('重扫后 bot_id 恢复', wechat.state.botId === 'bot_42', wechat.state.botId);

  outbox.length = 0;
  il.push({ from_user_id: 'wxid_again', context_token: 'CTX-9', msg_id: 'm9', item_list: [{ type: 1, text_item: { text: '邮箱 状态' } }] });
  for (let i = 0; i < 40 && !outbox.length; i++) await sleep(100);
  ok('重扫后仍能收消息', /一切正常/.test(outbox[0] || ''), outbox[0]);

  // 收尾
  await wechat.stop().catch(() => {});
  il.server.close();
  mcp.close();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }

  console.log(`\n${process.exitCode ? '✗ 有失败项' : `全部通过（${pass} 项断言）`}`);
}

main().catch((e) => {
  console.error('\n异常退出：' + (e?.stack || e));
  process.exitCode = 1;
});
