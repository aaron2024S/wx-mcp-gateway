// 验证 AI 路由层：用本地假端点模拟 OpenAI 与 Anthropic 两种协议，
// 不需要真 API key 就能确认「请求构造 / 响应解析 / 失败降级」三条都是对的。
// 用法：npm run test:llm

import http from 'node:http';
import { Registry } from '../src/registry.js';
import { routeWithLLM, listModels, normalizeUsage, LlmError } from '../src/llm.js';
import { probe } from '../src/router.js';

const PORT = 3399;
const seen = [];   // 记录收到的请求体，用于断言我们发了什么

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

// 假模型选工具：只从"实际收到的清单"里挑，真模型也只能这样。
function pickName(names, wantDelete) {
  const hit = names.find((n) => /delete/.test(n) === wantDelete);
  return hit || names[0] || (wantDelete ? 'fake_delete' : 'fake_send');
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    seen.push({ url: req.url, body: j, headers: req.headers });
    res.setHeader('content-type', 'application/json');

    if (req.url === '/v1/chat/completions') {
      const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
      if (!hasTools) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'no tools' } })); return; }
      // 模拟模型：只可能从"我们实际发给它的名字"里挑（真模型就是这么干的）。
      // 早先这里是硬编码 'fake.send'，于是名字转义一旦出错也测不出来。
      const said = j.messages?.at(-1)?.content || '';
      const names = j.tools.map((t) => t.function?.name).filter(Boolean);
      const name = pickName(names, /删/.test(said));
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name, arguments: JSON.stringify({ to: 'a@b.com' }) },
            }],
          },
        }],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      }));
      return;
    }

    if (req.url === '/v1/messages') {
      const said = j.messages?.[0]?.content || '';
      const names = (j.tools || []).map((t) => t.name).filter(Boolean);
      const name = pickName(names, /删/.test(said));
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'tu_1', name, input: { to: 'a@b.com' } },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      }));
      return;
    }

    // 严格端点：参数名不合规时直接 400（DeepSeek 就是这么回的点号工具名）。
    // 用来钉住"别把 invalid 当成 tool_choice 不支持而白重试一次"。
    if (req.url === '/strict/chat/completions') {
      res.statusCode = 400;
      res.end(JSON.stringify({
        error: { message: `Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.` },
      }));
      return;
    }

    // 只聊天、不调工具的模型（不支持 function calling 的那些）
    if (req.url === '/chatty/chat/completions') {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '我只能陪你聊天，帮不了你' } }],
        usage: { total_tokens: 9 },
      }));
      return;
    }

    if (req.url === '/v1/models' || req.url === '/v1/models?limit=100') {
      // 模型清单：按鉴权头区分协议，顺手验我们发的头对不对
      if (req.headers.authorization === 'Bearer bad' || req.headers['x-api-key'] === 'bad') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      const isAnthropic = Boolean(req.headers['x-api-key']);
      res.end(JSON.stringify({
        data: isAnthropic
          ? [{ id: 'claude-sonnet-4-5', type: 'model' }]
          : [{ id: 'deepseek-v4-pro', object: 'model' }, { id: 'deepseek-flash', object: 'model' }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });
});

const FAKE_TOOLS = [
  {
    key: 'fake.send', name: 'send', title: '发送消息',
    description: '把一条消息发送给指定的人',
    // 故意带上 $schema：MCP server 常常原样转发，严格端点会因此 400
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'SendArgs',
      type: 'object',
      properties: { to: { type: 'string' } },
      required: ['to'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    key: 'fake.delete', name: 'delete', title: '删除记录',
    description: '删除一条已经发出去的记录',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
];

function makeRegistry() {
  const cfg = {
    gateway: { call_timeout: 20, confirm_risk: ['high'], default_app: null },
    routing: { search_limit: 8 },
    apps: [],
  };
  const reg = new Registry(cfg);
  reg.apps.set('fake', {
    cfg: { id: 'fake', label: '测试', allow_risk: ['read', 'write'] },
    status: 'online',
    rawTools: FAKE_TOOLS.map((t) => ({
      name: t.name, title: t.title, description: t.description,
      inputSchema: t.inputSchema, annotations: t.annotations,
    })),
  });
  reg._build();
  return { reg, cfg };
}

function cfgWith(provider) {
  return {
    gateway: { call_timeout: 20, confirm_risk: ['high'] },
    routing: { search_limit: 8 },
    agent: { max_rounds: 4, max_ms: 15000 },
    llm: {
      enabled: true,
      default: 'p',
      timeout: 5,
      max_tokens: 256,
      providers: { p: provider },
    },
    apps: [],
  };
}

async function main() {
  await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));
  const { reg } = makeRegistry();

  console.log('\n=== OpenAI 兼容协议 ===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/v1`, model: 'mock-1', api_key: 'sk-test' });
    const r = await routeWithLLM({ text: '给 a@b.com 发一条消息', tools: reg.llmTools(), config: cfg });
    ok('解析出 tool_calls 里的工具名', r.tool === 'fake.send', String(r.tool));
    ok('解析出 arguments 对象', r.args?.to === 'a@b.com', JSON.stringify(r.args));
    ok('带回 provider / model', r.provider === 'p' && r.model === 'mock-1');
    ok('带回 token 用量（统一成 input/output/total）',
      r.usage?.input === 30 && r.usage?.output === 12 && r.usage?.total === 42,
      JSON.stringify(r.usage));
    const req = seen.at(-1);
    ok('请求发到了 /chat/completions', req.url === '/v1/chat/completions', req.url);
    ok('带了 Bearer 鉴权', String(req.headers.authorization || '') === 'Bearer sk-test');
    ok('tools 按 function 格式下发', req.body.tools?.[0]?.type === 'function' && !!req.body.tools[0].function?.parameters);
    ok('temperature 为 0（要确定性）', req.body.temperature === 0);
    const params = (req.body.tools.find((t) => /send/.test(t.function.name)) || req.body.tools[0]).function.parameters;
    ok('参数 schema 的 $schema 被剔除（严格端点会因此 400）',
      params.$schema === undefined && !!params.properties?.to, JSON.stringify(params));
  }

  console.log('\n=== Anthropic 协议 ===');
  {
    const cfg = cfgWith({ type: 'anthropic', base_url: `http://127.0.0.1:${PORT}`, model: 'mock-claude', api_key: 'ak-test' });
    const r = await routeWithLLM({ text: '删掉那条记录', tools: reg.llmTools(), config: cfg });
    ok('解析出 tool_use 块', r.tool === 'fake.delete', String(r.tool));
    ok('解析出 input 对象', r.args?.to === 'a@b.com', JSON.stringify(r.args));
    ok('Anthropic 的 input/output 也统一成同一形状',
      r.usage?.input === 20 && r.usage?.output === 8 && r.usage?.total === 28,
      JSON.stringify(r.usage));
    const req = seen.at(-1);
    ok('请求发到了 /v1/messages', req.url === '/v1/messages', req.url);
    ok('带了 x-api-key 头', String(req.headers['x-api-key'] || '') === 'ak-test');
    ok('带了 anthropic-version 头', !!req.headers['anthropic-version']);
    ok('tools 按 input_schema 格式下发', !!req.body.tools?.[0]?.input_schema);
  }

  console.log('\n=== 工具名转义（点号会被 DeepSeek/OpenAI 直接拒）===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/v1`, model: 'mock-1', api_key: 'k' });
    const tools = [
      {
        name: 'mail.list_messages', description: '列出邮件',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
          properties: { q: { type: 'string' } },
        },
      },
      { name: 'mail_list_messages', description: '撞名样本：转义后和上一条同形', inputSchema: { type: 'object', properties: {} } },
      { name: 'mail.read_attachment', description: '读附件', inputSchema: { type: 'object', properties: {} } },
    ];
    const r = await routeWithLLM({ text: '读一下附件', tools, config: cfg });
    const req = seen.at(-1);
    const sent = req.body.tools.map((t) => t.function.name);
    ok('发出去的名字全部合规（^[a-zA-Z0-9_-]{1,64}$）',
      sent.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), sent.join(','));
    ok('名字里不再有点号', !sent.some((n) => n.includes('.')), sent.join(','));
    // 撞名不处理的话两个工具会编成同一个名字，模型永远选不中后者
    ok('转义撞名时自动加序号，工具一个不丢',
      sent.length === 3 && new Set(sent).size === 3, sent.join(','));
    ok('返回的名字还原成原始 key', r.tool === 'mail.list_messages', String(r.tool));
    ok('参数 schema 的 $schema 被剔除、properties 保留',
      req.body.tools[0].function.parameters.$schema === undefined
      && !!req.body.tools[0].function.parameters.properties?.q);
  }

  console.log('\n=== 参数被拒时别当成「不支持 tool_choice」重发 ===');
  {
    // 原来的重试条件里带 /invalid/，于是 "Invalid 'tools[0].function.name'"
    // 这种参数本身的错也会被当成"可能不认 tool_choice"，白花一次请求还掩盖真因。
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/strict`, model: 'm', api_key: 'k' });
    const before = seen.length;
    let err = null;
    try { await routeWithLLM({ text: '随便说点什么', tools: reg.llmTools(), config: cfg }); } catch (e) { err = e; }
    ok('只发一次请求', seen.length - before === 1, `${seen.length - before} 次`);
    ok('错误原文保留，能看出是哪个字段', /tools\[0\]\.function\.name/.test(err?.message || ''), err?.message);
  }

  console.log('\n=== 模型只回话、不选工具（不支持 tool calling 的典型形态）===');
  {
    // 端点直接回一句人话、不调工具。自检要如实报「它只回话没干活」，
    // 并把原话带回来 —— 否则用户只看到"没选工具"，不知道它在聊什么。
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/chatty`, model: 'm', api_key: 'k' });
    const d = await probe('有几封未读邮件', { registry: reg, config: cfg });
    ok('结果是「说话」而不是执行', d.kind === 'say', String(d.kind));
    ok('把模型原话带回来', /只能陪你聊天/.test(d.reply || ''), String(d.reply));
  }

  console.log('\n=== 失败时不留悬空 ===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: 'http://127.0.0.1:1/v1', model: 'dead', api_key: 'k' });
    let err = null;
    try {
      await routeWithLLM({ text: '随便说点什么', tools: reg.llmTools(), config: cfg });
    } catch (e) { err = e; }
    ok('连不上时抛 LlmError', err instanceof LlmError, String(err));
    ok('错误类型是 network', err?.kind === 'network', err?.kind);

    // 自检（设置页那个「试一句」）撞上 AI 挂掉，必须给出可读原因而不是抛异常
    const d = await probe('把冰箱温度调低', { registry: reg, config: cfg });
    ok('自检不抛异常', d && typeof d === 'object');
    ok('自检说清没接上', d.kind === 'none' && !!d.error, JSON.stringify({ kind: d.kind, error: d.error }));
    ok('自检把模型试过的检索词带回来', Array.isArray(d.queries), JSON.stringify(d.queries));
  }

  console.log('\n=== 没配模型就没大脑（本地匹配已删）===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/v1`, model: 'mock-1', api_key: 'k' });
    cfg.llm = { enabled: false, providers: {} };
    const before = seen.length;
    const d = await probe('发送消息给老王', { registry: reg, config: cfg });
    ok('没配模型时不发任何请求', seen.length === before, `${seen.length - before} 次`);
    ok('并且明说没接上', d.kind === 'none' && /服务商|模型/.test(d.error || ''), String(d.error));
  }

  console.log('\n=== token 用量归一化（各家字段名不一样）===');
  {
    const u1 = normalizeUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    ok('OpenAI 系 prompt/completion → input/output',
      u1?.input === 1 && u1?.output === 2 && u1?.total === 3, JSON.stringify(u1));
    ok('没给 total 时自己加', normalizeUsage({ input_tokens: 5, output_tokens: 6 })?.total === 11);
    ok('只有 total 也能用', normalizeUsage({ total_tokens: 7 })?.total === 7);
    // null 和 0 必须能分开：前者界面显示「未上报」，后者是「真的没花」
    ok('没有 usage 返回 null 而不是 0', normalizeUsage(null) === null && normalizeUsage({}) === null);
  }

  console.log('\n=== 拉取模型清单（模型名不该写死在代码里）===');
  {
    const ids = await listModels({ base_url: `http://127.0.0.1:${PORT}/v1`, api_key: 'sk-test' });
    ok('OpenAI 兼容端点解析出模型 id', ids.join(',') === 'deepseek-v4-pro,deepseek-flash', ids.join(','));

    const anth = await listModels({ type: 'anthropic', base_url: `http://127.0.0.1:${PORT}`, api_key: 'sk-ant' });
    ok('Anthropic 协议走 x-api-key 并解析', anth[0] === 'claude-sonnet-4-5', anth.join(','));

    try {
      await listModels({ base_url: `http://127.0.0.1:${PORT}/v1`, api_key: 'bad' });
      ok('key 错要报错', false);
    } catch (e) {
      ok('key 错归为 auth 类', e instanceof LlmError && e.kind === 'auth', e.kind);
    }

    try {
      await listModels({ base_url: '' });
      ok('没填地址要拦下', false);
    } catch (e) {
      ok('没填地址归为 config 类', e instanceof LlmError && e.kind === 'config', e.kind);
    }
  }

  mock.close();
  console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 项，${fail} 项失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); mock.close(); process.exit(1); });
