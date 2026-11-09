// 执行层：放不放行、参数够不够、结果怎么变成人话。
//
// 三条铁律：
//   ① 风险判断以**网关自己的配置**为准，不信应用自报的 annotations（它可以写错或被改）；
//   ② 高危操作必须先确认，确认窗口有 TTL，过期作废；
//   ③ 执行结果不管是成功还是失败都要有回话——微信里最糟的体验是石沉大海。

const NAME_KEYS = ['subject', 'title', 'name', 'label', 'file_name', 'filename', 'text', 'summary', 'id', 'uid'];
const SUB_KEYS = ['from', 'sender', 'author', 'date', 'time', 'created_at', 'updated_at', 'size', 'count', 'unread'];

const RISK_LABEL = { read: '只读', write: '写入', high: '高危' };

export function riskLabel(r) {
  return RISK_LABEL[r] || r;
}

/**
 * 放行判断。返回 { verdict: 'ok' | 'confirm' | 'denied', reason }
 */
export function checkRisk(tool, appCfg, gwCfg) {
  const allow = appCfg?.allow_risk || ['read'];
  const confirmList = gwCfg?.confirm_risk || ['high'];

  // 配置里 allow_risk 是硬上限：应用说自己是 read，但网关只允许 read 以外的，
  // 也不会因为应用自报就放宽。这是"双保险"的下限那一层。
  if (!allow.includes(tool.risk)) {
    return {
      verdict: 'denied',
      reason: `「${tool.appLabel}」只开放 ${allow.map(riskLabel).join('/')} 操作，`
        + `「${tool.title || tool.name}」属于${riskLabel(tool.risk)}，被网关拦下了。`,
    };
  }
  if (confirmList.includes(tool.risk)) {
    return { verdict: 'confirm', reason: `${tool.title || tool.name}属于${riskLabel(tool.risk)}操作` };
  }
  return { verdict: 'ok' };
}

// ---- 参数 ------------------------------------------------------------

export function missingArgs(tool, args = {}) {
  const schema = tool.inputSchema || {};
  const req = Array.isArray(schema.required) ? schema.required : [];
  return req.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

function propOf(tool, name) {
  return tool.inputSchema?.properties?.[name] || {};
}

// 问用户要这个参数时说什么。优先用 schema 的 description（应用作者写的人话），
// 没有就退回字段名——这时候用户多半也看不懂，但至少知道要填什么。
export function describeParam(tool, name) {
  const p = propOf(tool, name);
  const label = p.title || p.description || name;
  const oneLine = String(label).split(/[。\n]/)[0].slice(0, 40);
  if (Array.isArray(p.enum) && p.enum.length) {
    return `「${oneLine}」可选：${p.enum.slice(0, 8).join(' / ')}`;
  }
  return `「${oneLine}」`;
}

// 把用户这一句话按当前缺失的第一个参数收下。
// 不猜类型转换——除非 schema 明说是 number/boolean，否则一律当字符串。
export function coerceArg(tool, name, raw) {
  const p = propOf(tool, name);
  const s = String(raw ?? '').trim();
  if (p.type === 'number' || p.type === 'integer') {
    const n = Number(s.replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : s;
  }
  if (p.type === 'boolean') {
    return /^(true|1|是|yes|y|开)$/i.test(s);
  }
  if (p.type === 'array') {
    return s.split(/[,，、\s]+/).filter(Boolean);
  }
  return s;
}

// 从一句话里挖参数（模板式输入）：
//   「发给 a@b.com 主题 周会 内容 晚上八点开会」
// 只处理显式带了分隔词的场景，不硬猜——猜错比多问一句糟得多。
export function parseInlineArgs(tool, text) {
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const out = {};
  const src = String(text || '');

  for (const [name, p] of Object.entries(props)) {
    const words = [name, p.title, ...(p.aliases || [])]
      .filter(Boolean)
      .map((w) => String(w).trim())
      .filter((w) => w.length >= 1);
    for (const w of words) {
      const re = new RegExp(`(?:^|\\s)${escapeRe(w)}\\s*[:：=]?\\s*([^\\s]+(?:\\s+[^\\s]+)*)$`);
      const m = src.match(re);
      if (m && m[1]) { out[name] = coerceArg(tool, name, m[1].trim()); break; }
    }
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 执行 ------------------------------------------------------------

export async function runTool(registry, tool, args, timeoutMs = 20000) {
  const app = registry.getApp(tool.appId);
  if (!app?.client) {
    return { isError: true, text: `「${tool.appLabel}」现在连不上，等它恢复再试。`, ms: 0, offline: true };
  }
  const started = Date.now();
  let timer;
  try {
    const res = await Promise.race([
      app.client.callTool(tool.name, args),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('工具执行超时'), { timeout: true })), timeoutMs); }),
    ]);
    return { ...res, ms: res.ms || Date.now() - started };
  } catch (e) {
    if (e?.timeout) {
      return { isError: true, text: `等太久没返回（超过 ${Math.round(timeoutMs / 1000)} 秒），可能还在跑，也可能卡住了。`, ms: Date.now() - started, timeout: true };
    }
    return { isError: true, text: `调用失败：${e?.message || e}`, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 渲染 ------------------------------------------------------------
// 目标不是"完整呈现"，是"在手机上一眼看出要点"。所以：
//   · 列表最多 8 条，多的折叠成一句；
//   · 每条一行，字段用 · 分隔；
//   · 单条文本超过 900 字截断（微信里刷屏更糟）。

function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// 从任意对象里挖出"最像列表"的那个数组
function findArray(data) {
  if (Array.isArray(data)) return { list: data, key: null };
  if (!isPlain(data)) return null;
  const prefer = ['messages', 'items', 'results', 'list', 'data', 'accounts', 'folders', 'rows', 'tools', 'files'];
  for (const k of prefer) {
    if (Array.isArray(data[k])) return { list: data[k], key: k, envelope: data };
  }
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && v.length && isPlain(v[0])) return { list: v, key: k, envelope: data };
  }
  return null;
}

function brief(v, max = 48) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => brief(x, 24)).filter(Boolean).join(', ').slice(0, max);
  if (isPlain(v)) {
    // 邮件 from 常是 {name, address}，取更像人名的那个
    for (const k of ['name', 'display_name', 'address', 'email', 'label', 'title', 'text']) {
      if (v[k]) return brief(v[k], max);
    }
    const first = Object.values(v).find((x) => typeof x === 'string');
    return first ? brief(first, max) : '';
  }
  return '';
}

function itemLine(item, idx) {
  if (!isPlain(item)) return `${idx}. ${brief(item, 80)}`;
  let name = '';
  for (const k of NAME_KEYS) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') { name = brief(item[k], 56); break; }
  }
  if (!name) {
    const firstStr = Object.entries(item).find(([, v]) => typeof v === 'string' && v.trim());
    name = firstStr ? brief(firstStr[1], 56) : '(无标题)';
  }
  const subs = [];
  for (const k of SUB_KEYS) {
    if (k === 'size' || k === 'count' || k === 'unread') continue;
    const v = item[k];
    if (v === undefined || v === null || v === '') continue;
    const s = brief(v, 24);
    if (s && s !== name) subs.push(s);
    if (subs.length >= 2) break;
  }
  // 跨账号列邮件时每条带 account（uid 只在单个账号内唯一）：不标出来，
  // 一串「未读」根本看不出是哪個邮箱的。放最前面，别跟 from/date 抢位置。
  const acct = typeof item.account === 'string' && item.account.trim()
    ? `[${brief(item.account, 20)}] `
    : '';
  const flags = [];
  if (item.seen === false || item.unread === true) flags.push('未读');
  // 数字型 unread 不能丢：list_accounts 这类工具专门算了各账号的未读数，
  // 渲染时扔掉的话，用户问「有没有未读」拿到的就是一列光秃秃的账号名
  if (typeof item.unread === 'number' && item.unread > 0) flags.push(`未读 ${item.unread}`);
  if (item.flagged === true || item.starred === true) flags.push('★');
  if (item.has_attachments === true || item.attachments?.length) flags.push('附件');

  return `${idx}. ${acct}${name}${subs.length ? ' · ' + subs.join(' · ') : ''}${flags.length ? '  [' + flags.join(' ') + ']' : ''}`;
}

function idOf(item) {
  if (!isPlain(item)) return null;
  for (const k of ['uid', 'id', 'key', 'name', 'path', 'message_id', 'msg_id']) {
    if (item[k] !== undefined && item[k] !== null) return { key: k, value: item[k] };
  }
  return null;
}

/**
 * @returns {{ text: string, items?: Array<{label:string, key:string, value:any}> }}
 */
export function renderResult(tool, res, { limit = 8 } = {}) {
  if (res.isError) {
    return { text: `没能完成「${tool.title || tool.name}」。\n${String(res.text || '').slice(0, 400)}` };
  }

  const found = res.data ? findArray(res.data) : null;

  if (found && found.list.length) {
    const shown = found.list.slice(0, limit);
    const lines = [
      `「${tool.title || tool.name}」共 ${found.list.length} 条${found.list.length > shown.length ? `，先看前 ${shown.length} 条` : ''}：`,
      ...shown.map((it, i) => itemLine(it, i + 1)),
    ];
    const items = [];
    for (const [i, it] of shown.entries()) {
      const id = idOf(it);
      if (id) {
        const label = itemLine(it, i + 1).replace(/^\d+\.\s*/, '').split('  [')[0];
        // uid 只在单个账号内唯一。跨账号列表（未读邮件就是典型）必须把账号一起记住，
        // 否则用户回「1」之后下一步拿到 uid 也定位不到是哪封信。
        const extra = id.key === 'uid' && typeof it.account === 'string' && it.account.trim()
          ? { account: it.account }
          : null;
        items.push({ label, argKey: id.key, value: id.value, ...(extra ? { extra } : {}) });
      }
    }
    if (found.list.length > shown.length) {
      lines.push(`（还有 ${found.list.length - shown.length} 条没列出来）`);
    }
    lines.push('回复序号可对某一条继续操作。');
    return { text: lines.join('\n'), items };
  }

  if (found && found.list.length === 0) {
    const env = found.envelope || {};
    const hint = env.hint || env.message || env.note;
    return { text: hint ? `「${tool.title || tool.name}」：${hint}` : `「${tool.title || tool.name}」没有数据。` };
  }

  // 非列表：纯文本截断
  const raw = String(res.text || '').trim();
  if (!raw) return { text: `「${tool.title || tool.name}」执行完成，没有返回内容。` };
  if (raw.length <= 900) return { text: raw };
  return { text: raw.slice(0, 900) + `\n…（共 ${raw.length} 字，已截断）` };
}
