// 识别层编排：一句话 → 决定调哪个工具。三条路，按代价从低到高。
//
//   ① 本地索引命中（零成本、零延迟）        ← 九成请求走这里
//   ② AI 路由（只有本地不自信时才调）        ← 关键：有 AI 也不让它接管一切
//   ③ 回菜单（AI 没配 / 挂了 / 也没听懂）    ← 必须回话，不能沉默
//
// 为什么不让 AI 一直跑：每句话多花 1~3 秒和一次请求，还会把「家里有哪些设备」
// 这种私密上下文发到外部。本地表能确定地解决的事，没理由付这个代价。

import { routeWithLLM, LlmError } from './llm.js';

function needLLM(mode, local) {
  switch (mode) {
    case 'never': return false;
    case 'always': return true;
    case 'ambiguous': return !local.confident || local.ambiguous;
    case 'miss':
    default: return !local.confident;
  }
}

async function tryLLM(text, registry, config, local, history) {
  const tools = registry.llmTools(local.appId || null);
  if (!tools.length) return { kind: 'none', error: '当前没有可用的工具（应用都离线？）' };

  try {
    const r = await routeWithLLM({ text, tools, config, history });
    if (!r.tool) {
      // 模型决定不调工具，只回了句话
      return r.text
        ? { kind: 'say', text: r.text, via: 'llm', provider: r.provider, model: r.model, ms: r.ms, usage: r.usage }
        : { kind: 'none', error: 'AI 没有选出工具' };
    }
    const tool = registry.find(r.tool);
    if (!tool) {
      // 模型编了个不存在的工具名——丢弃，不执行
      return { kind: 'none', error: `AI 选了一个不存在的工具「${r.tool}」` };
    }
    return {
      kind: 'call',
      tool,
      args: r.args || {},
      via: 'llm',
      provider: r.provider,
      model: r.model,
      ms: r.ms,
      usage: r.usage,
    };
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : (e?.message || String(e));
    return { kind: 'none', error: msg };
  }
}

// 当前这套配置下，AI 到底会不会被叫起来。设置页的「自检」直接拿它，
// 免得把"enabled 判断"抄两遍、抄歪了还查不出来。
export function llmState(config) {
  const providers = Object.keys(config.llm?.providers || {});
  const on = config.llm?.enabled === true && providers.length > 0;
  return {
    on,
    mode: config.routing?.llm_when || 'miss',
    providers,
    default: config.llm?.default || providers[0] || '',
    onError: config.llm?.on_error || 'local',
    // 开了开关但没服务商 = 最常见的"我明明开了呀"
    reason: on ? null
      : (config.llm?.enabled !== true ? '「启用 AI 兜底」开关是关的' : '没有可用的 AI 服务商'),
  };
}


/**
 * @returns {{kind:'call'|'say'|'menu', ...}}
 *   call: {tool, args, via:'local'|'llm', score?, provider?, ms?}
 *   say:  {text, via}
 *   menu: {candidates, note?}
 */
export async function route(text, { registry, config, history = [] }) {
  const local = registry.match(text);
  const st = llmState(config);
  const llmOn = st.on;
  const mode = st.mode;

  // ① AI 优先模式：先问 AI，失败再回落本地
  if (llmOn && mode === 'always') {
    const r = await tryLLM(text, registry, config, local, history);
    if (r.kind === 'call' || r.kind === 'say') return r;
    // 回落也要留下证据：用户开了「总是问 AI」却看到日志写"本地"，不给原因就没法查。
    if (local.confident) {
      return {
        kind: 'call',
        tool: local.best.tool,
        args: {},
        via: 'local',
        score: local.best.score,
        degraded: true,
        aiError: r.error || 'AI 没有给出可用的工具',
      };
    }
    return { kind: 'menu', candidates: menuList(registry, local), note: r.error, aiError: r.error };
  }

  // ② 本地自信：直接执行，不惊动 AI。
  //
  // 但「命中但有歧义」这一档要在这里拦一道：分数过了 confident 线不等于选对了，
  // 前两名咬得很近（registry 的 ambiguous，差值 < 0.12）时仍可能挑错。
  // 这个判断必须放在 confident 之前——原来放后面，于是从来走不到，
  // 那一档和「本地没命中时」行为完全一样，等于摆设。
  const askBecauseAmbiguous = llmOn && mode === 'ambiguous' && local.ambiguous;
  if (local.confident && !askBecauseAmbiguous) {
    return { kind: 'call', tool: local.best.tool, args: {}, via: 'local', score: local.best.score };
  }

  // ③ 本地不自信（或命中但有歧义），看配置要不要问 AI
  if (llmOn && (askBecauseAmbiguous || needLLM(mode, local))) {
    const r = await tryLLM(text, registry, config, local, history);
    if (r.kind === 'call' || r.kind === 'say') return r;
    // AI 失败。两种回落策略：
    //   local —— 用本地索引的结果（有候选就给候选，没候选给全量）
    //   menu  —— 忽略本地结果，直接给全量菜单（本地信号太弱时更合适）
    if (config.llm.on_error === 'menu') {
      return { kind: 'menu', candidates: menuList(registry, null), note: r.error };
    }
    return { kind: 'menu', candidates: menuList(registry, local), note: r.error };
  }

  // ④ 纯本地兜底
  if (local.understood && local.candidates.length) {
    return {
      kind: 'menu',
      candidates: menuList(registry, local),
      note: local.ambiguous ? '有几种可能的操作，你要哪个？' : '是要做这个吗？',
    };
  }
  return { kind: 'menu', candidates: menuList(registry, local), note: '没听懂' };
}

// 候选列表：有匹配就给匹配的，一个都没有就给全部（只读优先，高危靠后）
const RISK_ORDER = { read: 0, write: 1, high: 2 };

export function menuList(registry, local, limit = 8) {
  if (local?.candidates?.length) {
    return local.candidates.slice(0, limit).map((c) => ({
      key: c.tool.key,
      label: c.tool.title || c.tool.name,
      appLabel: c.tool.appLabel,
      risk: c.tool.risk,
      score: Number(c.score.toFixed(2)),
    }));
  }
  return [...registry.tools]
    .sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((t) => ({
      key: t.key,
      label: t.title || t.name,
      appLabel: t.appLabel,
      risk: t.risk,
      score: 0,
    }));
}

// 中文菜单文本（微信里直接发）
export function renderMenu(candidates, note) {
  const lines = [];
  if (note) lines.push(note);
  candidates.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.appLabel} · ${c.label}${c.risk === 'high' ? '（高危）' : ''}`);
  });
  if (!candidates.length) lines.push('当前没有可用的操作。');
  return lines.join('\n');
}
