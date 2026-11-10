// test-loop.js —— 闭环编排（llm.agentLoop）的单测
//
// 为什么单独一个脚本：e2e.js 锁的是**单轮**行为（本地命中、降级、自动打开、换词），
// 闭环是另一条路径。混在一起的话，一处判据改动会让两套用例一起红，分不清是
// "闭环退化了"还是"单轮本来就这样"。
//
// 这里用一个可编排的假模型端点：按 script 依次回「调哪个工具」或「最终回答」，
// 完全不碰 MCP——被测的是编排本身：能不能多轮、结果会不会回灌、会不会原地打转、
// 写操作会不会被拦下来。
import http from 'node:http';
import { agentLoop } from '../src/llm.js';
import { renderResult } from '../src/exec.js';

let pass = 0; let fail = 0;
function ok(name) { pass += 1; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail += 1; console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else bad(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function truthy(name, v) { if (v) ok(name); else bad(name, `实际 ${JSON.stringify(v)}`); }

// 假端点：script 里每一项要么是 '最终回答字符串'，要么是 {tool, args}
function mockLlm(script) {
  const seen = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const body = JSON.parse(buf || '{}');
      seen.push(body);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      const names = (body.tools || []).map((t) => t.function?.name).filter(Boolean);
      if (typeof step === 'string') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: step } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
        return;
      }
      // 真实端点只会回清单里有的名字，且是转义后的（点号被换成下划线）
      const want = names.find((n) => n === step.tool || n.endsWith(`_${step.tool.split('.').pop()}`)) || names[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `c${i}`, type: 'function', function: { name: want, arguments: JSON.stringify(step.args || {}) } }],
          },
        }],
        usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
      }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => server.close(),
  })));
}

function cfg(url) {
  return {
    llm: {
      enabled: true, default: 'd', timeout: 10, max_tokens: 512,
      providers: { d: { type: 'openai', base_url: url, model: 'fake', api_key: 'k' } },
    },
    agent: { mode: 'auto', max_rounds: 5, max_ms: 20000 },
  };
}

const TOOLS = [
  {
    name: 'mail.search_messages', description: '按关键词搜邮件',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'mail.read_message', description: '读正文',
    inputSchema: { type: 'object', properties: { uid: { type: 'number' } }, required: ['uid'] },
  },
  {
    name: 'mail.send_message', description: '发信（高危）',
    inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
  },
];

async function main() {
  // ① 三轮：搜「火车」空 → 换「12306」命中 → 给出回答
  {
    const llm = await mockLlm([
      { tool: 'search_messages', args: { query: '火车' } },
      { tool: 'search_messages', args: { query: '12306' } },
      '最近一次是 2026 年 4 月 15 日 G745 北京南到苏州北。',
    ]);
    const calls = [];
    const r = await agentLoop({
      text: '我最近一次坐火车是什么时候',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async (name, args) => {
        calls.push({ name, args });
        if (args.query === '火车') return { ok: true, text: '没搜到和「火车」相关的邮件。可以换成平台名再搜。' };
        return { ok: true, text: '找到 12 封：2026-04-15 G745 北京南-苏州北 567 元' };
      },
    });
    eq('三轮后给出回答', r.stop, 'answered');
    truthy('答案里带上了车次', /G745/.test(r.text));
    eq('执行了两次工具', calls.length, 2);
    eq('第二次换成了 12306', calls[1].args.query, '12306');
    eq('第二轮的对话里有第一轮结果', llm.seen[2].messages.filter((m) => m.role === 'tool').length, 2);
    truthy('回灌内容带着「没搜到」的证据', /没搜到/.test(
      llm.seen[2].messages.filter((m) => m.role === 'tool')[0]?.content || ''));
    truthy('用量是累加的（三轮 > 一轮）', r.usage.total >= 360);
    llm.close();
  }

  // ② 原地打转：同一工具同一参数连着来，第二次就停
  {
    const llm = await mockLlm([
      { tool: 'search_messages', args: { query: '验证码' } },
      { tool: 'search_messages', args: { query: '验证码' } },
      { tool: 'search_messages', args: { query: '验证码' } },
    ]);
    const r = await agentLoop({
      text: '验证码是多少',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async () => ({ ok: true, text: '没搜到' }),
    });
    eq('无进展就停', r.stop, 'no-progress');
    eq('只跑了三轮以内', r.rounds <= 3, true);
    llm.close();
  }

  // ③ 写操作不在循环里执行，交回上层确认
  {
    const llm = await mockLlm([{ tool: 'send_message', args: { to: 'a@b.com' } }]);
    let ran = 0;
    const r = await agentLoop({
      text: '发给 a@b.com',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async (name) => {
        ran += 1;
        if (name === 'mail.send_message') return { halt: { tool: { key: name, risk: 'high' }, args: { to: 'a@b.com' } } };
        return { ok: true, text: '' };
      },
    });
    eq('写操作被 halt', r.stop, 'halt');
    eq('halt 带回工具', r.halted?.tool?.key, 'mail.send_message');
    eq('执行回调确实被问了一次', ran, 1);
    llm.close();
  }

  // ④ 轮数用尽
  {
    const script = Array.from({ length: 8 }, (_, n) => ({ tool: 'search_messages', args: { query: `q${n}` } }));
    const llm = await mockLlm(script);
    const r = await agentLoop({
      text: '一直查',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async () => ({ ok: true, text: '空' }),
    });
    eq('用尽轮数就收手', r.stop, 'max-rounds');
    eq('正好跑满配置的轮数', r.rounds, 5);
    llm.close();
  }

  // ⑤ 历史带上：接着上一轮说「那个」
  {
    const llm = await mockLlm(['接上一轮：还是那封旅游合同。']);
    await agentLoop({
      text: '那个再详细点',
      tools: TOOLS,
      config: cfg(llm.url),
      history: [
        { role: 'user', content: '有没有旅游相关的邮件' },
        { role: 'assistant', content: '找到一封旅游合同签订成功通知' },
      ],
      execute: async () => ({ ok: true, text: '' }),
    });
    const msgs = llm.seen[0].messages;
    truthy('历史被带进去了', msgs.some((m) => m.role === 'user' && /旅游相关的邮件/.test(m.content || '')));
    truthy('上一轮的回答也在', msgs.some((m) => m.role === 'assistant' && /旅游合同/.test(m.content || '')));
    eq('最后一条是这一句', msgs[msgs.length - 1].content, '那个再详细点');
    llm.close();
  }

  // ⑥ 工具名转义往返：内部是「应用.工具」，发给模型必须是合法名
  {
    const llm = await mockLlm([{ tool: 'mail.search_messages', args: { query: 'x' } }, '好']);
    const used = [];
    await agentLoop({
      text: '查',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async (name) => { used.push(name); return { ok: true, text: 'ok' }; },
    });
    const sentNames = llm.seen[0].tools.map((t) => t.function.name);
    truthy('发给模型的名字里没有点号', sentNames.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));
    eq('回调拿到的是内部原名', used[0], 'mail.search_messages');
    llm.close();
  }

  // ⑦ 列表渲染：给模型的那份必须带 uid/account/folder，给用户的那份一个都不能带
  //
  // 2026-11-10 线上：用户问「今天的邮件」→ 模型列了 3 封 → 用户说「华为的」→
  // 模型要读正文，但渲染出来的行里只有「[QQ邮箱] 华为开发者联盟 · 通知 · 今天 17:57」，
  // 没有任何定位信息，它只能挨个猜 uid，每次都撞「邮件不存在」，五轮烧完放弃。
  {
    const res = {
      data: {
        total: 2,
        messages: [
          { uid: 423, account: 'QQ邮箱', folder: 'INBOX', subject: '测试邮件', from: 'a@163.com', date: '2026-11-10T11:42:27.000Z', unread: true },
          { uid: 422, account: 'QQ邮箱', folder: 'INBOX', subject: '华为开发者联盟通知', from: 'news@huawei.com', date: '2026-11-10T09:57:02.000Z', unread: true },
        ],
      },
    };
    const tool = { title: '列出邮件', name: 'list_messages' };
    const forModel = renderResult(tool, res, { forModel: true }).text;
    const forUser = renderResult(tool, res).text;
    truthy('给模型的文本带 uid', /uid=422/.test(forModel));
    truthy('给模型的文本带账号与文件夹', /account=QQ邮箱/.test(forModel) && /folder=INBOX/.test(forModel));
    truthy('给用户的文本不带 uid', !/uid=/.test(forUser));
    truthy('给用户的文本不带 account=', !/account=/.test(forUser));
    truthy('给模型的不再说「回复序号」', !/回复序号/.test(forModel));
    eq('两种渲染的条目都没少', forModel.split('\n').length, forUser.split('\n').length);
  }

  // ⑧ trace 存的是给用户看的版本：模型看到 uid，日志和兜底消息看不到
  {
    const llm = await mockLlm([{ tool: 'search_messages', args: { query: '华为' } }, '没找到正文']);
    const r = await agentLoop({
      text: '华为那封写了啥',
      tools: TOOLS,
      config: cfg(llm.url),
      execute: async () => ({
        ok: false,
        text: '「搜索邮件」共 1 条：\n1. 华为通知  → uid=422，account=QQ邮箱',
        visible: '「搜索邮件」共 1 条：\n1. 华为通知',
      }),
    });
    const toolMsg = llm.seen[1].messages.filter((m) => m.role === 'tool')[0]?.content || '';
    truthy('模型拿到的是带 uid 的那份', /uid=422/.test(toolMsg));
    truthy('trace 里是给人看的那份', !/uid=/.test(r.trace[0].text) && /华为通知/.test(r.trace[0].text));
    llm.close();
  }

  console.log(`\n闭环用例：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
