// AI 路由层：只做一件事 —— 把「一句话 + 工具清单」变成 {tool, args}。
//
// 边界（很重要，别越界）：
//   · 它不执行任何工具，不生成代码，不发请求到应用；
//   · 它返回的工具名要由上层用 registry.find() 校验，模型编出来的名字直接丢弃；
//   · 风险判断、二次确认、审计全在执行层，AI 碰不到。
// 这样即使模型幻觉，最坏结果是「选错工具」，而不是「乱执行」。
//
// 两家协议够了：
//   openai     —— /chat/completions + function calling。覆盖 OpenAI、DeepSeek、通义、Kimi、
//                 智谱、Groq、Ollama、vLLM、LM Studio 等一切兼容端点。
//   anthropic  —— /v1/messages + tool_use。Claude 系。
// 新增一家通常只是加一段配置，不用写代码。

const SYSTEM_PROMPT = `你是一个指令路由器。用户会用中文说一句话，你要从给定的工具里选出一个来执行。

规则：
1. 只能选给定清单里的工具，不要编造；不确定就选最接近的，宁可错也不要空着。
2. 用户的要求需要多个工具时，只选第一步。
3. 参数只填用户明确说出的内容，没说的不要猜、不要编默认值。
4. 不要解释、不要道歉、不要输出额外文字，只调用工具。`;

export class LlmError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;   // auth | rate | timeout | http | format | network | config
    this.detail = detail;
  }
}

function pickFinish(msg) {
  // 有些兼容端点把 arguments 直接给成对象，有的给字符串
  const raw = msg?.arguments;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

async function post(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new LlmError('timeout', `AI 请求超时（${Math.round(timeoutMs / 1000)}s）`, { url });
    throw new LlmError('network', 'AI 服务连不上', { url, message: e?.message });
  } finally {
    clearTimeout(timer);
  }
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* 下面按状态码判 */ }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate'
      : 'http';
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new LlmError(kind, msg, { status: res.status, body: txt.slice(0, 300) });
  }
  if (!json) throw new LlmError('format', 'AI 返回的不是 JSON', { body: txt.slice(0, 200) });
  return json;
}

// ---------- OpenAI 兼容 ----------
async function callOpenAI(text, tools, p, timeoutMs, maxTokens) {
  const headers = { ...p.headers };
  if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;

  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    tools: tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    })),
    temperature: 0,
    max_tokens: maxTokens,
  };

  let json;
  try {
    json = await post(`${p.base_url}/chat/completions`, headers, { ...body, tool_choice: 'auto' }, timeoutMs);
  } catch (e) {
    // 有些兼容端点不认 tool_choice，去掉再试一次
    if (e.kind === 'http' && /tool_choice|unsupported|invalid/i.test(e.message)) {
      json = await post(`${p.base_url}/chat/completions`, headers, body, timeoutMs);
    } else throw e;
  }

  const msg = json?.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call) {
    return { tool: null, text: msg?.content || '', usage: json?.usage || null };
  }
  return {
    tool: call.function?.name || null,
    args: pickFinish(call.function),
    text: msg?.content || '',
    usage: json?.usage || null,
  };
}

// ---------- Anthropic ----------
async function callAnthropic(text, tools, p, timeoutMs, maxTokens) {
  const headers = {
    'x-api-key': p.api_key,
    'anthropic-version': '2023-06-01',
    ...p.headers,
  };
  const body = {
    model: p.model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    })),
    temperature: 0,
  };
  const json = await post(`${p.base_url}/v1/messages`, headers, body, timeoutMs);
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const use = blocks.find((b) => b?.type === 'tool_use');
  if (!use) {
    const say = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    return { tool: null, text: say, usage: json?.usage || null };
  }
  return { tool: use.name || null, args: use.input || {}, text: '', usage: json?.usage || null };
}

const ADAPTERS = { openai: callOpenAI, anthropic: callAnthropic };

// 候选顺序：指定 → 默认 → 配置里的 fallback 链
function candidates(cfg, preferred) {
  const llm = cfg.llm || {};
  const order = [];
  if (preferred) order.push(preferred);
  if (llm.default) order.push(llm.default);
  for (const f of llm.fallback || []) order.push(f);
  const seen = new Set();
  return order
    .filter((id) => id && !seen.has(id) && seen.add(id) && llm.providers?.[id])
    .map((id) => ({ id, ...llm.providers[id], type: llm.providers[id].type || 'openai' }));
}

/**
 * 让 AI 选一个工具。失败会按 fallback 链换下一家；全挂了抛 LlmError。
 * @returns {{tool:string|null, args:object, via:'llm', provider:string, model:string, ms:number, usage:object|null, text:string}}
 */
export async function routeWithLLM({ text, tools, config, providerId }) {
  if (!config.llm?.enabled) throw new LlmError('config', 'AI 路由未启用');
  if (!tools.length) throw new LlmError('config', '没有可用的工具');

  const list = candidates(config, providerId);
  if (!list.length) throw new LlmError('config', '没有可用的 AI 服务商');

  const timeoutMs = (config.llm.timeout || 15) * 1000;
  const maxTokens = config.llm.max_tokens || 512;
  const failures = [];
  const errors = [];

  for (const p of list) {
    const adapter = ADAPTERS[p.type];
    if (!adapter) { failures.push(`${p.id}: 不支持的协议 ${p.type}`); continue; }
    const started = Date.now();
    try {
      const r = await adapter(text, tools, p, timeoutMs, maxTokens);
      return {
        tool: r.tool,
        args: r.args || {},
        text: r.text || '',
        via: 'llm',
        provider: p.id,
        model: p.model,
        usage: r.usage,
        ms: Date.now() - started,
      };
    } catch (e) {
      failures.push(`${p.id}: ${e.message}`);
      errors.push(e);
    }
  }
  // 只有一个候选时保留原始错误类型（timeout / auth / network），
  // 上层才能给出「是超时还是 key 错了」这种能指导排查的提示
  if (errors.length === 1) throw errors[0];
  throw new LlmError('http', `所有 AI 服务商都失败了：${failures.join('；')}`, { failures });
}

// 配置页用：列出可选服务商（不含密钥）
export function listProviders(config) {
  const llm = config.llm || {};
  return Object.entries(llm.providers || {}).map(([id, p]) => ({
    id,
    label: p.label || id,
    type: p.type || 'openai',
    model: p.model,
    base_url: p.base_url,
    has_key: !!p.api_key,
    is_default: llm.default === id,
  }));
}
