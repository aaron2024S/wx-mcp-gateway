// 验证 AI 路由层：用本地假端点模拟 OpenAI 与 Anthropic 两种协议，
// 不需要真 API key 就能确认「请求构造 / 响应解析 / 失败降级」三条都是对的。
// 用法：npm run test:llm

import http from 'node:http';
import { Registry } from '../src/registry.js';
import { routeWithLLM, listModels, LlmError } from '../src/llm.js';
import { route } from '../src/router.js';

const PORT = 3399;
const seen = [];   // 记录收到的请求体，用于断言我们发了什么

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

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
      // 模拟模型：根据用户说的话挑一个工具
      const said = j.messages?.at(-1)?.content || '';
      const name = /删/.test(said) ? 'fake.delete' : 'fake.send';
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
      const name = /删/.test(said) ? 'fake.delete' : 'fake.send';
      res.end(JSON.stringify({
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'tu_1', name, input: { to: 'a@b.com' } },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
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
    inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
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
    routing: { local_threshold: 0.5, ask_threshold: 0.25, llm_when: 'miss' },
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
    routing: { local_threshold: 0.5, ask_threshold: 0.25, llm_when: 'miss' },
    llm: {
      enabled: true,
      default: 'p',
      timeout: 5,
      max_tokens: 256,
      on_error: 'local',
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
    ok('带回 token 用量', r.usage?.total_tokens === 42, JSON.stringify(r.usage));
    const req = seen.at(-1);
    ok('请求发到了 /chat/completions', req.url === '/v1/chat/completions', req.url);
    ok('带了 Bearer 鉴权', String(req.headers.authorization || '') === 'Bearer sk-test');
    ok('tools 按 function 格式下发', req.body.tools?.[0]?.type === 'function' && !!req.body.tools[0].function?.parameters);
    ok('temperature 为 0（要确定性）', req.body.temperature === 0);
  }

  console.log('\n=== Anthropic 协议 ===');
  {
    const cfg = cfgWith({ type: 'anthropic', base_url: `http://127.0.0.1:${PORT}`, model: 'mock-claude', api_key: 'ak-test' });
    const r = await routeWithLLM({ text: '删掉那条记录', tools: reg.llmTools(), config: cfg });
    ok('解析出 tool_use 块', r.tool === 'fake.delete', String(r.tool));
    ok('解析出 input 对象', r.args?.to === 'a@b.com', JSON.stringify(r.args));
    const req = seen.at(-1);
    ok('请求发到了 /v1/messages', req.url === '/v1/messages', req.url);
    ok('带了 x-api-key 头', String(req.headers['x-api-key'] || '') === 'ak-test');
    ok('带了 anthropic-version 头', !!req.headers['anthropic-version']);
    ok('tools 按 input_schema 格式下发', !!req.body.tools?.[0]?.input_schema);
  }

  console.log('\n=== 失败与降级 ===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: 'http://127.0.0.1:1/v1', model: 'dead', api_key: 'k' });
    let err = null;
    try {
      await routeWithLLM({ text: '随便说点什么', tools: reg.llmTools(), config: cfg });
    } catch (e) { err = e; }
    ok('连不上时抛 LlmError', err instanceof LlmError, String(err));
    ok('错误类型是 network', err?.kind === 'network', err?.kind);

    // route 撞上 AI 挂掉，必须回落而不是崩溃
    const r = await route('把冰箱温度调低', { registry: reg, config: cfg });
    ok('route 不抛异常，返回菜单', r.kind === 'menu', r.kind);
    ok('菜单里带了失败原因', /连不上|失败/.test(r.note || ''), r.note);
    ok('菜单里仍有可选项', Array.isArray(r.candidates) && r.candidates.length > 0);
  }

  console.log('\n=== 本地命中时不该惊动 AI ===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/v1`, model: 'mock-1', api_key: 'k' });
    const before = seen.length;
    const r = await route('发送消息给老王', { registry: reg, config: cfg });
    ok('走的是本地索引', r.via === 'local', String(r.via));
    ok('没有发出任何 AI 请求', seen.length === before, `${seen.length - before} 次`);
  }

  console.log('\n=== llm_when 配置生效 ===');
  {
    const cfg = cfgWith({ type: 'openai', base_url: `http://127.0.0.1:${PORT}/v1`, model: 'mock-1', api_key: 'k' });
    cfg.routing.llm_when = 'never';
    const r = await route('把冰箱温度调低', { registry: reg, config: cfg });
    ok('never 模式下不调 AI', r.kind === 'menu' && r.note === '没听懂', String(r.note));
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
