// 菜单渲染 + 自检。
//
// 这个文件以前是「识别层」：本地索引命中就直接执行、命中不了再问 AI、还不行就回菜单。
// 那条路已经删了——本地够 0.5 分就执行会错着执行（实测 25 句里有 2 句选错工具还跑了），
// 而错一次删除类操作的代价远大于"多问一句"。
//
// 现在只剩两个东西：
//   · renderMenu —— 应用内的 /menu 和"挑一个"仍然需要它（纯展示，不做决定）
//   · probe      —— 设置页那个「试一句」。它把「候选是谁、AI 选了谁、花了多少」
//                   一次打印出来，是接了几个应用之后唯一能看清上下文开销的窗口。

import { agentLoop, SEARCH_TOOL, LlmError } from './llm.js';

export function llmState(config) {
  const providers = Object.keys(config.llm?.providers || {});
  const on = config.llm?.enabled === true && providers.length > 0;
  return {
    on,
    providers,
    default: config.llm?.default || providers[0] || '',
    reason: on ? null : '没有可用的 AI 服务商',
  };
}

/**
 * 自检：走一遍**和线上完全一样**的闭环，只是把执行换成"到此为止"。
 *
 * 为什么不能沿用「本地先筛 8 个候选再问 AI」：那会把自检变成另一条链路，
 * 测出来的东西跟用户真发一句话时发生的事没关系（真实链路里是模型自己决定搜什么）。
 * 这里用 halt 代替 execute，所以能如实看到：模型检索了什么词、命中哪些工具、
 * 它选了谁、带什么参数、烧了多少 token——而一个工具都不会真被执行。
 *
 * @returns {{kind:'call'|'say'|'none', candidates:Array, queries:string[], tool?:object,
 *            args?:object, ms:number, error?:string}}
 */
export async function probe(text, { registry, config, history = [] } = {}) {
  const started = Date.now();
  const limit = Math.min(Math.max(Number(config.routing?.search_limit) || 8, 3), 20);

  const queries = [];
  const seen = new Map();       // key -> {tool, score}

  let r;
  try {
    r = await agentLoop({
      text,
      tools: [SEARCH_TOOL],
      catalog: registry.catalogText(),
      search: (q, o) => {
        const res = registry.search(q, { limit, ...o });
        queries.push(String(q || ''));
        for (const it of res.results) {
          const prev = seen.get(it.tool.key);
          if (!prev || prev.score < it.score) seen.set(it.tool.key, { tool: it.tool, score: it.score });
        }
        return res;
      },
      config,
      history,
      maxRounds: 4,
      maxMs: 30000,
      // 只判断、不执行：第一次真的要调工具就停下，把结果原样交回去
      execute: async (name, args) => ({ halt: { tool: registry.find(name), args } }),
    });
  } catch (e) {
    const msg = e instanceof LlmError ? e.message : (e?.message || String(e));
    return { kind: 'none', candidates: [], queries, error: msg, ms: Date.now() - started };
  }

  const candidates = [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .map((it) => ({
      key: it.tool.key,
      label: it.tool.title || it.tool.name,
      appLabel: it.tool.appLabel,
      risk: it.tool.risk,
      score: Number(it.score.toFixed(2)),
    }));

  const base = {
    candidates, queries, provider: r.provider, model: r.model, usage: r.usage, ms: Date.now() - started,
  };

  if (r.stop === 'halt' && r.halted?.tool) {
    return { ...base, kind: 'call', tool: r.halted.tool, toolKey: r.halted.tool.key, args: r.halted.args || null };
  }
  if (r.stop === 'answered') {
    return { ...base, kind: 'say', reply: String(r.text || '').slice(0, 200) };
  }
  return {
    ...base,
    kind: 'none',
    error: r.stop === 'timeout'
      ? 'AI 想太久（超过 30 秒），先停下了'
      : (queries.length ? 'AI 检索了工具，但没决定调哪一个' : 'AI 没检索也没调工具'),
  };
}

const RISK_ORDER = { read: 0, write: 1, high: 2 };

// 候选列表：有匹配就给匹配的，一个都没有就给全部（只读优先，高危靠后）
export function menuList(registry, local, limit = 8) {
  const cands = local?.candidates || local?.results || [];
  if (cands.length) {
    return cands.slice(0, limit).map((c) => ({
      key: c.tool.key,
      label: c.tool.title || c.tool.name,
      appLabel: c.tool.appLabel,
      risk: c.tool.risk,
      score: Number((c.score || 0).toFixed(2)),
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
