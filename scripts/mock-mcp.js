// 本地联调用的假 MCP server：模拟一个"邮件"应用，带 3 个只读 + 2 个写入 + 1 个高危工具。
// 只给开发时看界面用，不参与生产。
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 7799);
const calls = [];

const TOOLS = [
  { name: 'list_accounts', title: '列出邮箱账号', description: '列出已配置的邮箱账号', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  { name: 'list_messages', title: '列出邮件', description: '按时间倒序分页列出某文件夹的邮件摘要（发件人、主题、时间、已读、星标）', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { folder: { type: 'string', description: '文件夹名，默认收件箱' }, page: { type: 'number', description: '页码' } } } },
  { name: 'search_messages', title: '搜索邮件', description: '按关键词搜索邮件正文和主题', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } },
  { name: 'read_message', title: '读取邮件正文', description: '读取指定邮件的完整内容', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { uid: { type: 'string', description: '邮件 uid' } }, required: ['uid'] } },
  { name: 'set_flags', title: '标记邮件', description: '设置已读/星标等标记', annotations: {}, inputSchema: { type: 'object', properties: { uid: { type: 'string' }, seen: { type: 'boolean' } }, required: ['uid'] } },
  { name: 'delete_messages', title: '删除邮件', description: '把邮件移入已删除', annotations: { destructiveHint: true }, inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] } },
];

const MAILS = {
  total: 5,
  messages: [
    { uid: 'a1', subject: '合同确认', from: { name: '张三', address: 'zs@corp.com' }, date: '今天 09:12', seen: false },
    { uid: 'a2', subject: '十月报价单', from: { name: '李四' }, date: '昨天', seen: false },
    { uid: 'a3', subject: '周会纪要（10/31）', from: { name: '王五' }, date: '3 天前', seen: true },
    { uid: 'a4', subject: 'NAS 硬盘采购', from: { name: '京东' }, date: '4 天前', seen: true, has_attachments: true },
    { uid: 'a5', subject: '订阅续费提醒', from: { name: 'GitHub' }, date: '上周', seen: true },
  ],
};

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
        serverInfo: { name: 'mock-mail', version: '1.4.2' },
      });
    }
    if (body.method === 'notifications/initialized') { res.writeHead(200).end('{}'); return; }
    if (body.method === 'tools/list') return reply({ tools: TOOLS });
    if (body.method === 'tools/call') {
      const { name, arguments: args } = body.params;
      calls.push({ name, args, at: Date.now() });
      if (name === 'list_messages') {
        return reply({ content: [{ type: 'text', text: JSON.stringify(MAILS) }] });
      }
      if (name === 'list_accounts') {
        const accounts = { accounts: [{ id: 'me', address: 'me@example.com', unread: 2 }] };
        return reply({ content: [{ type: 'text', text: JSON.stringify(accounts) }] });
      }
      if (name === 'read_message') {
        if (args.uid === 'boom') {
          return reply({ isError: true, content: [{ type: 'text', text: '邮件不存在或已被删除' }] });
        }
        return reply({ content: [{ type: 'text', text: '这是一封邮件的正文……（模拟内容）' }] });
      }
      return reply({ content: [{ type: 'text', text: `已执行 ${name}` }] });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock mcp on http://127.0.0.1:${PORT}/mcp`));
