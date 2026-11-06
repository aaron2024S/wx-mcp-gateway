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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
};

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
        return reply({
          tools: [
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
          ],
        });
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
  const agent = new Agent({
    registry, config, sessions, log,
    hooks: { send: async (chatId, text, ctx) => { outbox.push(text); await wechat.send(chatId, text, ctx); } },
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
