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
3. 用户明确说出的内容必须填进对应参数：点名了哪个邮箱、文件夹、账号、数量、时间，就必须带上，
   不能省略、不能改用工具的默认值——省略往往意味着「查全部」，结果会答非所问。
   用户没说的不要猜、不要编默认值。
4. 不要解释、不要道歉、不要输出额外文字，只调用工具。
5. 工具描述里点名了某类问法的，按描述选；两个都能答时，选能直接给出用户要看的东西的那个——
   要看明细就别选只给统计数字的（统计完还得再查一次，用户只能干等）。
6. 这是连续对话，前面几轮会一起给你。用户这句话可能是在接着说上一轮的事
   （「总结一下」「这个」「那封」「再详细点」「换成英文」）。接着上一轮的对象做，
   不要当成新请求重新列一遍。要看上一轮某一条的内容，就选那个"读详情/读正文"的工具。`;

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

// 把「前几轮发生了什么」拼成对话消息。
//
// 只给一句话的摘要，不给完整结果，也不给工具 schema：模型需要知道的只是
// 「刚才问了旅游邮件，回了一条『旅游合同签订成功通知』」——够了就能接上话，
// 给太多反而把这一句真正的意图淹掉，还白烧 token。
function historyMessages(history) {
  const out = [];
  for (const h of Array.isArray(history) ? history : []) {
    const role = h?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h?.content ?? '').trim().slice(0, 1000);
    if (!content) continue;
    const last = out[out.length - 1];
    // Anthropic 严格要求 user / assistant 交替，相邻同角色先合并；
    // OpenAI 侧合并也完全没问题。
    if (last && last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  }
  return out;
}

// ---------- OpenAI 兼容 ----------
async function callOpenAI(text, tools, p, timeoutMs, maxTokens, history) {
  const headers = { ...p.headers };
  if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;

  const body = {
    model: p.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historyMessages(history),
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
async function callAnthropic(text, tools, p, timeoutMs, maxTokens, history) {
  const headers = {
    'x-api-key': p.api_key,
    'anthropic-version': '2023-06-01',
    ...p.headers,
  };
  const body = {
    model: p.model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [...historyMessages(history), { role: 'user', content: text }],
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
export async function routeWithLLM({ text, tools, config, providerId, history }) {
  if (!config.llm?.enabled) throw new LlmError('config', '还没有配置 AI 模型');
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
      const r = await adapter(text, prepared.wire, p, timeoutMs, maxTokens, history);
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

// 只用来「把一段内容说成人话」——例如读完一整封信之后给个摘要。
// 不做工具选择，也不带 tools 参数。
// 失败一律抛给调用方：摘要只是锦上添花，绝不该让用户因此看不到东西。
export async function chatOnce({ messages, config, maxTokens = 400, providerId = null }) {
  const list = candidates(config, providerId);
  if (!list.length) throw new LlmError('config', '没有可用的 AI 服务商');

  const timeoutMs = (config.llm?.timeout || 15) * 1000;
  let lastErr = null;

  for (const p of list) {
    const base = String(p.base_url || '').trim().replace(/\/+$/, '');
    if (!base) { lastErr = new LlmError('config', `${p.id}: 没填接口地址`); continue; }
    const anthropic = p.type === 'anthropic';
    const headers = anthropic
      ? { 'x-api-key': p.api_key, 'anthropic-version': '2023-06-01', ...p.headers }
      : { ...p.headers, ...(p.api_key ? { Authorization: `Bearer ${p.api_key}` } : {}) };

    try {
      if (anthropic) {
        const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        const rest = messages.filter((m) => m.role !== 'system');
        const json = await post(`${base}/v1/messages`, headers, {
          model: p.model, max_tokens: maxTokens, temperature: 0.3,
          ...(sys ? { system: sys } : {}), messages: rest,
        }, timeoutMs);
        const text = (json?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
        return { text, provider: p.id, model: p.model, usage: normalizeUsage(json?.usage) };
      }
      const json = await post(`${base}/chat/completions`, headers, {
        model: p.model, messages, temperature: 0.3, max_tokens: maxTokens,
      }, timeoutMs);
      const text = json?.choices?.[0]?.message?.content || '';
      return { text, provider: p.id, model: p.model, usage: normalizeUsage(json?.usage) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new LlmError('http', 'AI 没有给出内容');
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

// ---------- 多轮工具循环（Agent 模式） ----------
// 这里和上面的 routeWithLLM 是两种世界观：
//   routeWithLLM：一句话 → 一次决策 → {tool, args}。执行、判据、措辞全在上层的硬编码规则里，
//                 模型只是"把话翻译成参数"，它根本没机会看到结果、也就没法补救。
//   agentLoop：  一句话 → 决策 → 执行 → 把结果压成摘要回灌 → 再决策 …… 直到模型说"够了"。
// 2026-11-10 实测的差距：问「上次坐火车去哪」，单轮只能拿到 0 命中就认输；
// 而多轮里有 3 次机会换词（火车→12306），换到就查到了。这不是模型聪明与否，
// 是它能不能看见"上一次尝试的结果"。
// 网关版的「目录 + 按需加载」。
//
// 为什么不能把工具全塞进来：一个应用 22 个工具就是 4.5k token（实测），接三个
// 应用常驻 20k，而闭环每轮都要带一遍。WorkBuddy 挂 649 个连接器不慢，是因为
// 常驻的只有「名字 + 一行描述」，schema 到用的时候才取。
//
// 这里的做法是同一个思路，但检索器是本地那个中文分词 + idf 的匹配器，
// 比关键词搜索准，而且**不预筛**——模型自己决定搜什么、搜几次。
const AGENT_PROMPT = `你在微信里帮用户查东西、办事。你有一批工具，但**没有全部列出来**：
下面只有每个应用的目录，真正的工具要先用 search_tools 取出来才能调用。

规则：
1. 用户要做什么，先在目录里找对应的应用；要用里面的工具，先调 search_tools
   （query 写用户的原话或关键词，例如「硬盘温度」「未读邮件」），拿到工具后再调它。
   不要凭空编工具名——没在清单里的名字调用会失败。
2. 每一轮只调一个工具；需要更多信息就继续调，别急着下结论。
3. 用户点名的范围必须原样带上：指明哪个账号/邮箱、哪个文件夹、要几条，就照填，不许省略、不许改默认值。
4. 但「检索词」不是范围，是你的判断：用户说「火车」你就该想到搜 12306，「游戏订单」想到 Steam，
   「航班」想到行程单/航司名。可以按常识替换、可以多试几个词，换词之后在回答里说明你换了什么。
5. 搜不到不等于没有。先换词再搜，最多换两次；仍然没有，才说没查到，并说明试过哪些词。
6. 答案必须能指出来源：几封、哪一封、什么时间、哪台设备。指不出来就不许答——不许把「看到了清单」
   说成「看过了正文」，不许编造没出现过的金额、日期、单号、容量。
7. 只有一种情况可以停：你已经拿到了足以回答用户这句话的信息。
8. 用中文回答，微信里看，3 到 6 句，不要 markdown、不要列表符号、不要分点编号。
9. 工具返回里出现 hint / note 时，按其中的指引继续，不要忽略。
10. 权限不足、命令不存在这类错误，如实告诉用户缺什么，不要反复重试同一个调用。

现在开始。用户这句话可能是在接着上一轮说（「那个」「再详细点」），有历史就接着上一轮的对象做。`;

// 两个协议的差别只在"怎么把上一轮的工具调用和结果塞回对话"，其余流程完全一样。
// 把差别收进这两个小适配器，循环本身就不用分叉。
const LOOP_ADAPTERS = {
  openai: {
    async step({ messages, wire, p, timeoutMs, maxTokens }) {
      const headers = { ...p.headers };
      if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;
      const json = await post(`${p.base_url}/chat/completions`, headers, {
        model: p.model,
        messages,
        tools: wire.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: maxTokens,
      }, timeoutMs);
      const msg = json?.choices?.[0]?.message || {};
      const call = msg.tool_calls?.[0] || (msg.function_call ? { function: msg.function_call } : null);
      return {
        tool: call?.function?.name || null,
        args: call ? pickFinish(call.function) : {},
        text: msg.content || '',
        id: call?.id || `call_${Date.now()}`,
        raw: msg.content || '',
        usage: json?.usage || null,
      };
    },
    pushCall(messages, s) {
      messages.push({
        role: 'assistant',
        content: s.raw || null,
        tool_calls: [{ id: s.id, type: 'function', function: { name: s.wireName, arguments: JSON.stringify(s.args || {}) } }],
      });
    },
    pushResult(messages, s, content) {
      messages.push({ role: 'tool', tool_call_id: s.id, content });
    },
  },
  anthropic: {
    async step({ messages, wire, p, timeoutMs, maxTokens }) {
      const headers = { 'x-api-key': p.api_key, 'anthropic-version': '2023-06-01', ...p.headers };
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const rest = messages.filter((m) => m.role !== 'system');
      const json = await post(`${p.base_url}/v1/messages`, headers, {
        model: p.model,
        max_tokens: maxTokens,
        ...(sys ? { system: sys } : {}),
        messages: rest,
        tools: wire.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        temperature: 0,
      }, timeoutMs);
      const blocks = Array.isArray(json?.content) ? json.content : [];
      const use = blocks.find((b) => b?.type === 'tool_use');
      return {
        tool: use?.name || null,
        args: use?.input || {},
        text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'),
        id: use?.id || null,
        raw: blocks,
        usage: json?.usage || null,
      };
    },
    pushCall(messages, s) {
      messages.push({ role: 'assistant', content: s.raw });
    },
    pushResult(messages, s, content) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: s.id, content }] });
    },
  },
};

/**
 * 多轮工具循环。
 * @param {object} o
 * @param {string} o.text      用户这句话
 * @param {Array}  o.tools     常驻工具（现在是 [search_tools] 一个）
 * @param {string} [o.catalog] 可用应用目录，拼进系统提示词
 * @param {(q:string,o?:object)=>{results:Array<{tool:object,score:number}>}} [o.search]
 *        按需检索：给一句话，返回候选工具（完整 schema）。模型自己决定搜什么。
 * @param {object} o.config    完整配置
 * @param {Array}  o.history   最近几轮对话
 * @param {(name:string,args:object)=>Promise<{ok:boolean,text:string,halt?:object,sig?:string}>} o.execute
 * @param {number} o.maxRounds 最多几轮（默认 6）
 * @param {number} o.maxMs     总时间预算
 */
export async function agentLoop({
  text, tools, config, history = [], execute, search, catalog = '', maxRounds = 6, maxMs = 50000, providerId = null,
}) {
  const list = candidates(config, providerId);
  if (!list.length) throw new LlmError('config', '没有可用的 AI 服务商');
  if (!tools?.length && !search) throw new LlmError('config', '当前没有可用的工具');
  const p = list[0];
  const timeoutMs = Math.max(5000, (config.llm?.timeout || 15) * 1000);
  const started = Date.now();
  const adapter = LOOP_ADAPTERS[p.type] || LOOP_ADAPTERS.openai;

  // 已经取回来的工具。检索一次就把 schema 挂上去，后面每一轮都能直接用。
  const loaded = new Map();

  const messages = [{
    role: 'system',
    content: catalog ? `${AGENT_PROMPT}\n\n可用应用（只有目录，工具要检索）：\n${catalog}` : AGENT_PROMPT,
  }];
  for (const m of historyMessages(history)) messages.push(m);
  messages.push({ role: 'user', content: text });

  const trace = [];
  const usage = { input: 0, output: 0, total: 0 };
  const addUsage = (u) => {
    const n = normalizeUsage(u);
    if (!n) return;
    usage.input += n.input || 0;
    usage.output += n.output || 0;
    usage.total += n.total || (n.input || 0) + (n.output || 0);
  };

  let lastSig = '';
  let same = 0;
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (Date.now() - started > maxMs) {
      return { text: '', trace, usage, rounds, stop: 'timeout', provider: p.id, model: p.model };
    }
    // 每轮重新编一次名字，但顺序固定（常驻在前、取回的按插入序），
    // 所以同一个工具在各轮里拿到的是同一个 wire name，模型不会看到名字漂移。
    const all = [...(tools || []), ...loaded.values()];
    const { wire, back } = prepareTools(all);
    const wireOf = new Map(wire.map((w) => [back.get(w.name), w.name]));

    const s = await adapter.step({ messages, wire, p, timeoutMs, maxTokens: Number(config.llm?.max_tokens) || 900 });
    rounds = round;
    addUsage(s.usage);

    if (!s.tool) {
      // 模型认为够了：这就是最终回答
      return { text: String(s.text || '').trim(), trace, usage, rounds, stop: 'answered', provider: p.id, model: p.model };
    }

    const realName = unwireName(back, s.tool);
    const callArgs = s.args || {};

    // 检索这一跳不走执行层：它是网关自己的能力，不属于任何一个应用。
    if (realName === 'search_tools' && search) {
      const q = String(callArgs.query ?? '').trim();
      const app = callArgs.app ? String(callArgs.app) : undefined;
      let found = [];
      try {
        found = search(q, { appId: app })?.results || [];
      } catch { /* 检索失败就当没命中，别把整轮打死 */ }
      let payload;
      if (!found.length) {
        payload = `没有找到和「${q || '（空）'}」有关的工具。换一个说法再检索一次；如果确实没有这个能力，就直接告诉用户做不到。`;
      } else {
        for (const it of found) {
          if (!loaded.has(it.tool.key)) loaded.set(it.tool.key, toLlmTool(it.tool));
        }
        payload = [
          `检索「${q || '（空）'}」命中 ${found.length} 个工具，现在都可以调用了：`,
          ...found.map((it) => `· ${it.tool.key} — ${oneLine(it.tool)}`),
          '（用上面的完整名字调用，参数看各自的 schema）',
        ].join('\n');
      }
      trace.push({ tool: 'search_tools', args: { query: q, app: app || '' }, ok: true, text: payload });
      s.wireName = wireOf.get('search_tools') || s.tool;
      adapter.pushCall(messages, s);
      adapter.pushResult(messages, s, payload);
      continue;
    }

    const r = await execute(realName, callArgs);
    if (r?.halt) {
      // 写操作/高危操作不在循环里自动执行，交回上层的确认流程
      return { text: '', trace, usage, rounds, stop: 'halt', halted: r.halt, provider: p.id, model: p.model };
    }

    // 无进展检测：同一工具同一参数连续两次，说明它在原地打转，再多轮也是白烧钱
    const sig = r?.sig || `${realName}|${JSON.stringify(callArgs)}`;
    if (sig === lastSig) {
      same += 1;
      if (same >= 2) {
        return { text: '', trace, usage, rounds, stop: 'no-progress', provider: p.id, model: p.model };
      }
    } else {
      same = 0;
      lastSig = sig;
    }

    // trace 里存「给用户看的」版本：执行层返回 visible 时以它为准。
    // 模型看到的那份会带 uid/account/folder 这类定位参数（不给 uid 它只能瞎猜），
    // 而 trace 会在「没查完」时被原样发给用户，内部参数一个都不能露出去。
    trace.push({ tool: realName, args: callArgs, ok: r?.ok !== false, text: String((r?.visible ?? r?.text) || '') });
    s.wireName = wireOf.get(realName) || s.tool;
    adapter.pushCall(messages, s);
    adapter.pushResult(messages, s, String(r?.text || '（没有内容）'));
  }

  return { text: '', trace, usage, rounds, stop: 'max-rounds', provider: p.id, model: p.model };
}

// registry 里那条工具 → 喂给模型的样子。截 600 是历史经验：应用作者常把
// 最要紧的一句（「指名了邮箱就必须传 account」）放在描述末尾，剪太短正好剪掉。
function toLlmTool(t) {
  const desc = [t.title, t.description].filter(Boolean).join('：');
  return {
    name: t.key,
    description: desc.length > 600 ? `${desc.slice(0, 600)}…` : desc,
    inputSchema: t.inputSchema,
  };
}

function oneLine(t) {
  const s = String(t.title || t.description || '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// 检索工具的声明。它和真工具长得一样，模型不需要知道这是个"网关内建"的东西。
export const SEARCH_TOOL = {
  name: 'search_tools',
  description: '按一句话检索可用的工具。想用的能力不在当前清单里时，先用它搜（query 用用户的原话或关键词）。返回的工具会立刻变得可调用。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要做什么，中文原话即可，例如「硬盘温度」「未读邮件」「重启容器」' },
      app: { type: 'string', description: '只在这个应用里找（应用 id），一般不用填' },
    },
    required: ['query'],
  },
};
