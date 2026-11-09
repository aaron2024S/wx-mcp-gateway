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
4. 不要解释、不要道歉、不要输出额外文字，只调用工具。
5. 工具描述里点名了某类问法的，按描述选；两个都能答时，选能直接给出用户要看的东西的那个——
   要看明细就别选只给统计数字的（统计完还得再查一次，用户只能干等）。`;

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

// 让服务商自己报出它能用的模型名。
//
// 模型名迭代比代码快得多：DeepSeek 的 deepseek-chat / deepseek-reasoner 已于 2026-07-24
// 退役，现在只有 deepseek-flash 和 deepseek-v4-pro。任何写死在预设里的名字都会过期，
// 过期的表现是「测试连接」报模型不存在——用户完全看不出是名字旧了。
// OpenAI 兼容端点 GET {base}/models；Anthropic GET {base}/v1/models。
export async function listModels({ type = 'openai', base_url, api_key = '', timeoutMs = 15000 }) {
  const base = String(base_url || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('config', '先填接口地址');

  const anthropic = type === 'anthropic';
  const url = anthropic ? `${base}/v1/models?limit=100` : `${base}/models`;
  const headers = anthropic
    ? { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' }
    : (api_key ? { Authorization: `Bearer ${api_key}` } : {});

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, txt;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
    txt = await res.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new LlmError('timeout', `读取模型列表超时（${Math.round(timeoutMs / 1000)}s）`, { url });
    throw new LlmError('network', '连不上这个地址', { url, message: e?.message });
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = JSON.parse(txt); } catch { /* 下面按状态码判 */ }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate'
      : 'http';
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new LlmError(kind, msg, { status: res.status, body: txt.slice(0, 300) });
  }

  const arr = Array.isArray(json) ? json : (json?.data || json?.models || []);
  const ids = arr
    .map((m) => (typeof m === 'string' ? m : (m?.id || m?.name)))
    .filter((s) => typeof s === 'string' && s.trim());
  if (!ids.length) throw new LlmError('format', '没有从返回里找到模型名', { body: txt.slice(0, 200) });
  return [...new Set(ids)];
}

// ---------- 工具名转义 ----------
// OpenAI / DeepSeek / Anthropic 的 function name 都只接受 ^[a-zA-Z0-9_-]{1,64}$。
// 我们的工具名是「应用.工具」（mail.list_messages），那个点号会被直接拒绝：
//   Invalid 'tools[0].function.name': string does not match pattern ...
// 而且现象极具误导性：添加服务商时「测试连接」用的是个叫 noop 的假工具（合法名），
// 所以显示「通了 · 857 ms」，一按「试一句」换成真实工具清单就 400——看起来像是
// 「测试连接在骗人」或者「根本没接上 AI」，其实只是名字没转义。
// 出口转义、入口还原，上层拿到的永远是原始 key，注册表查找逻辑不受影响。
const NAME_LIMIT = 64;

function wireName(raw, used) {
  let base = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  if (base.length > NAME_LIMIT) base = base.slice(0, NAME_LIMIT);
  let name = base;
  let i = 2;
  // 转义可能撞名（a.b 与 a_b 都编成 a_b），撞了加序号，宁可难看也不能丢工具
  while (used.has(name)) name = `${base.slice(0, NAME_LIMIT - 4)}_${i++}`;
  used.add(name);
  return name;
}

function prepareTools(tools) {
  const used = new Set();
  const back = new Map();
  const wire = tools.map((t) => {
    const name = wireName(t.name, used);
    back.set(name, t.name);
    return { ...t, name, inputSchema: cleanSchema(t.inputSchema) };
  });
  return { wire, back };
}

function unwireName(back, name) {
  if (!name) return null;
  if (back.has(name)) return back.get(name);
  const low = String(name).toLowerCase();
  for (const [k, v] of back) if (k.toLowerCase() === low) return v;
  return name;   // 模型编的名字原样上抛，由 registry.find() 丢弃
}

// 有些 MCP server 会把完整的 JSON Schema 元数据塞进参数定义，$schema / examples
// 这类关键字在严格校验的端点上是 400 的来源。只删这两个，别的原样保留——
// 多删可能把 $ref 的指向破坏掉。
function cleanSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'object', properties: {} };
  const drop = new Set(['$schema', '$id', '$comment', 'examples']);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (drop.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = {};
      for (const [pk, pv] of Object.entries(v)) out[k][pk] = cleanSchema(pv);
    } else if (k === 'items') {
      out[k] = cleanSchema(v);
    } else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.map((x) => cleanSchema(x));
    } else {
      out[k] = v;
    }
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
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
    // 有些兼容端点不认 tool_choice，去掉再试一次。
    // 只认"明确提到 tool_choice"的报错 —— 原来还匹配了 /invalid/，
    // 于是 Invalid 'tools[0].function.name' 这种参数本身的错也被当成
    // "可能不支持 tool_choice"，白花一次请求还掩盖了真正原因。
    if (e.kind === 'http' && /tool_choice/i.test(e.message)) {
      json = await post(`${p.base_url}/chat/completions`, headers, body, timeoutMs);
    } else throw e;
  }

  const msg = json?.choices?.[0]?.message;
  // 老式 function_call（部分自建端点只实现了这个）也认一下
  const call = msg?.tool_calls?.[0] || (msg?.function_call ? { function: msg.function_call } : null);
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

// 各家报 token 用量的字段名不一样，统一成 {input, output, total}。
// 为什么要在这一层统一：控制台要显示「这次 AI 花了多少」，如果上层拿到的
// 是 prompt_tokens / input_tokens 两种形状，那判断逻辑就会散在 UI 里。
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const input = n(u.prompt_tokens) ?? n(u.input_tokens);
  const output = n(u.completion_tokens) ?? n(u.output_tokens);
  const total = n(u.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  if (input === null && output === null && total === null) return null;
  return { input, output, total };
}

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

  // 转义只跟工具清单有关、跟服务商无关，循环外做一次
  const prepared = prepareTools(tools);

  for (const p of list) {
    const adapter = ADAPTERS[p.type];
    if (!adapter) { failures.push(`${p.id}: 不支持的协议 ${p.type}`); continue; }
    const started = Date.now();
    try {
      const r = await adapter(text, prepared.wire, p, timeoutMs, maxTokens);
      return {
        tool: unwireName(prepared.back, r.tool),
        args: r.args || {},
        text: r.text || '',
        via: 'llm',
        provider: p.id,
        model: p.model,
        usage: normalizeUsage(r.usage),
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
