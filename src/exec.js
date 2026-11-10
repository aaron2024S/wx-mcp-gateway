// 执行层：放不放行、参数够不够、结果怎么变成人话。
//
// 三条铁律：
//   ① 风险判断以**网关自己的配置**为准，不信应用自报的 annotations（它可以写错或被改）；
//   ② 高危操作必须先确认，确认窗口有 TTL，过期作废；
//   ③ 执行结果不管是成功还是失败都要有回话——微信里最糟的体验是石沉大海。

const NAME_KEYS = ['subject', 'title', 'name', 'label', 'file_name', 'filename', 'text', 'summary', 'id', 'uid'];
const SUB_KEYS = ['from', 'sender', 'author', 'date', 'time', 'created_at', 'updated_at', 'size', 'count', 'unread'];
// 时间字段的几种常见写法。列邮件/记录的工具几乎都用这几个键之一。
const TIME_KEYS = ['date', 'time', 'created_at', 'updated_at', 'received_at', 'sent_at', 'timestamp'];

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
  // 已经是目标类型的别再过一遍字符串：数组被 String() 之后会变成 "a,b"，
  // 布尔被当成 "true" 都是多余的破坏。
  if ((p.type === 'number' || p.type === 'integer') && typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (p.type === 'boolean' && typeof raw === 'boolean') return raw;
  if (p.type === 'array' && Array.isArray(raw)) return raw;
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

// 交给应用之前，把参数整形成 schema 认的样子。
//
// 应用侧基本都是 zod 严格校验：多一个 schema 里没有的键、该给数字的给了空值，
// 整条调用会被直接拒掉，报回来的还是「expected number, received NaN」这种
// 只有写代码的人看得懂的话。模型和用户都不会照着 schema 说话，所以这层归我们。
export function prepareArgs(tool, args = {}) {
  const props = tool.inputSchema?.properties;
  const out = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out;
  for (const [k, v] of Object.entries(args)) {
    if (props && !(k in props)) continue;                        // 没声明的键，传了也只会被拒
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;   // NaN / Infinity
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = coerceArg(tool, k, v);
  }
  return out;
}

// 一句话里的参数有两个来源：模型读懂的（aiArgs）和用户按模板敲的（inlineArgs）。
// 后者是显式输入，优先级更高；模型给空的时候由它补位。
export function mergeArgs(tool, aiArgs = {}, inlineArgs = {}) {
  const props = tool.inputSchema?.properties;
  const base = (aiArgs && typeof aiArgs === 'object' && !Array.isArray(aiArgs)) ? { ...aiArgs } : {};

  // 模型常把 schema 里的 query 写成 keyword、把 uid 写成 id。只有一个必填项缺、
  // 而模型又只多给了「一个」schema 不认识的标量时，把它挪过去——
  // 比回头问用户「关键词是什么」体面得多。只挪一个，避免瞎配对。
  const knownKeys = props ? Object.keys(props) : [];
  const strays = Object.entries(base).filter(([k, v]) => !knownKeys.includes(k)
    && (typeof v === 'string' || typeof v === 'number'));
  const miss = missingArgs(tool, prepareArgs(tool, base));
  if (props && miss.length === 1 && strays.length === 1) base[miss[0]] = strays[0][1];

  return { ...prepareArgs(tool, base), ...prepareArgs(tool, inlineArgs) };
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

// 邮件时间在返回里常是 ISO（2026-11-09T06:05:00Z）。直接抛给用户，微信里是一串没人会读的
// 字符，而且它还是 UTC——和用户手机上的钟差 8 小时。这里统一转本地时间：当天写「今天 14:05」，
// 同年省略年份。认不出来的（「昨天」「3 天前」这种应用已经写好的）原样放过。
function humanTime(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

// 列表项的时间，用来挑「最近的那一条」。应用给的常是 ISO，也有给 Unix 秒/毫秒的；
// 认不出来就返回 null，调用方退回「按应用给的顺序取第一条」。
// 2026-11-10 实测：「steam登录验证码是多少」要的是**最新**那封验证码邮件，
// 而搜索结果里混着一堆购买回执——按顺序取第几条不靠谱，得按时间。
function timeOf(item) {
  if (!isPlain(item)) return null;
  for (const k of TIME_KEYS) {
    const v = item[k];
    if (typeof v === 'number' && v > 0) {
      const at = v < 1e12 ? v * 1000 : v;   // 秒 / 毫秒
      return { at, when: humanTime(new Date(at).toISOString()) };
    }
    if (typeof v !== 'string' || !v.trim()) continue;
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
      const at = Date.parse(v.replace(' ', 'T'));
      if (!Number.isNaN(at)) return { at, when: humanTime(v) };
    }
  }
  return null;
}

// 邮件信头里的「认证结果」「Return-Path」是给模型判断钓鱼用的机器串，
// 应用习惯把它们拼在正文前面。例如：
//   认证结果：mx.qq.com; spf=pass smtp.mailfrom=<econtract@pushmail…> (ip=205.205.208.10) …
// 一串 IP、等号和 @，人读不出任何信息，却把真正的正文挤到九百字之外。这里把它折叠成一句。
// 只动「有中文标签：+ 值超过 140 字 + 几乎没有中文 + 含 = @ ;」的行：
// 中文长段落、正文里的链接列表都不满足，不会被误伤。
function foldMachineLines(text) {
  return text.split('\n').map((line) => {
    if (line.length <= 140) return line;
    const m = line.match(/^([^：:\n]{1,14})[：:]\s*(.+)$/);
    if (!m) return line;
    const value = m[2];
    if (!/[=@;]/.test(value)) return line;
    const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk / value.length > 0.2) return line;
    return `${m[1]}：${value.slice(0, 60)}…（省略 ${value.length - 60} 字）`;
  }).join('\n');
}

// 应用返回的纯文本里常夹着写给模型看的定位信息，以及未格式化的 UTC 时间戳。
//   · 「· uid=101」——用户看到只会问「uid 是什么」
//   · 「2026-11-09T06:05:00Z」——一串没人会读的字符，而且还是 UTC，和手机上的钟差 8 小时
// 只清这两种形状（都极固定，不会误伤邮件正文）。不带 Z 的时间不动，当作已经是本地时间。
function humanize(raw) {
  return shortenUrls(String(raw || '')
    // 单独的回车（老式 CRSF / 信头折行）在微信里会把同一行反复覆盖，看起来像乱码，
    // 统一当换行处理。先处理 \r\n，再把剩下的裸 \r 换掉。
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s*[·|]\s*uid\s*=\s*\d+/gi, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z/g, (m) => humanTime(m))
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

// 行内的超长链接是另一种机器串：Steam / 营销邮件的追踪链接动辄八九百字，一行就把正文刷没了。
// 更糟的是它会让上面那条折叠规则把整行（连同这行里的正常中文）一起当机器串折掉——
// 2026-11-10 实测：「请先访问 https：//help.steampowered.com/…」被折成「…（省略 120 字）」，
// 用户看到的安全提示只剩半句，后面「验证您的位置再继续」整段消失。
// 只动 100 字以上的链接，收成前 60 字：域名和路径开头还在，看得出是哪个站。
function shortenUrls(text) {
  return text.replace(/https?[:：]\/\/[^\s，。；）)】」"]{100,}/gi, (u) => `${u.slice(0, 60)}…`);
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
    const isTimeKey = TIME_KEYS.includes(k);
    const s = brief(isTimeKey ? humanTime(v) : v, 24);
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

// 应用把校验失败原样抛回来时，用户看到的是
// 「MCP error -32602: Input validation error: Invalid arguments for tool
//   read_attachment: Invalid input: expected number, received NaN at index」——
// 一句话里三个内部名词，谁看都只会觉得"坏了"。这类错误是**我们参数没凑齐**，
// 说清楚「差什么、怎么办」就够了；原始报文留在容器日志里给排查用。
function humanError(raw) {
  const s = String(raw || '').trim();
  if (/Input validation error|Invalid arguments|-32602/i.test(s)) {
    return '这个操作需要的信息我没凑齐，应用那边没通过校验。换个说法再来一次，或者先让我把清单列给你看。';
  }
  return s.slice(0, 400);
}

// 每条列表项后面补一段「继续操作时该传什么」。只给模型看，不给用户看——
// 用户看到「uid=422 · folder=INBOX」只会问「这是什么」。
//
// 为什么必须有：闭环里模型拿到的是**渲染后的文本**，不是应用的原始 JSON。
// 原来的行里只有「[QQ邮箱] 华为开发者联盟 · 【通知】… · 今天 17:57」，一个可用的
// 标识都没有，模型要读正文只能瞎猜 uid——2026-11-10 线上实测就是连猜几个，
// 每次都被回「邮件不存在」，五轮烧光后不了了之。
function locatorOf(id, extra = {}, item = null) {
  const parts = [`${id.key}=${id.value}`];
  if (extra.account) parts.push(`account=${extra.account}`);
  if (extra.folder) parts.push(`folder=${extra.folder}`);
  // 文件夹这种条目，显示的是 name，真正能当参数用的是 path（「已发送」的实际路径
  // 可能是 Sent Messages）。两个不一样就一起给，省得模型拿着显示名去猜。
  const p = isPlain(item) && typeof item.path === 'string' ? item.path.trim() : '';
  if (p && p !== String(id.value) && !extra.folder) parts.push(`path=${p}`);
  return `  → ${parts.join('，')}`;
}

/**
 * @param {object} [o]
 * @param {number} [o.limit]    列表最多渲染几条
 * @param {boolean} [o.forModel] 给模型看：每行补上 uid/account/folder 这类定位参数
 * @returns {{ text: string, items?: Array<{label:string, key:string, value:any}> }}
 */
export function renderResult(tool, res, { limit = 8, forModel = false } = {}) {
  if (res.isError) {
    return { text: `没能完成「${tool.title || tool.name}」。\n${humanError(res.text)}` };
  }

  const found = res.data ? findArray(res.data) : null;

  if (found && found.list.length) {
    const shown = found.list.slice(0, limit);
    const lines = [
      `「${tool.title || tool.name}」共 ${found.list.length} 条${found.list.length > shown.length ? `，先看前 ${shown.length} 条` : ''}：`,
    ];
    const items = [];
    for (const [i, it] of shown.entries()) {
      const line = itemLine(it, i + 1);
      const id = idOf(it);
      if (!id) { lines.push(line); continue; }
      const label = line.replace(/^\d+\.\s*/, '').split('  [')[0];
      // uid 只在单个账号、单个文件夹内唯一。跨账号列表（未读邮件就是典型）必须把账号
      // 一起记住，否则用户回「1」之后下一步拿到 uid 也定位不到是哪封信；
      // 搜出来 / 列出来的信不在收件箱时同理，得带上它所在的文件夹。
      const extra = {};
      if (id.key === 'uid') {
        if (typeof it.account === 'string' && it.account.trim()) extra.account = it.account.trim();
        if (typeof it.folder === 'string' && it.folder.trim()) extra.folder = it.folder.trim();
      }
      // 带上时间戳：用户问「验证码是多少」时，下一步要挑**最新**那封打开，
      // 而搜索结果里往往混着一堆同发件人的旧邮件（购买回执之类）。
      const t = timeOf(it);
      items.push({
        label, argKey: id.key, value: id.value,
        ...(t ? { at: t.at, when: t.when } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
      });
      lines.push(forModel ? `${line}${locatorOf(id, extra, it)}` : line);
    }
    if (found.list.length > shown.length) {
      lines.push(`（还有 ${found.list.length - shown.length} 条没列出来）`);
    }
    // 跨账号合并的结果必须自己说明白。2026-11-09 实测：用户问「outlook 未读邮件」，
    // 模型漏了 account 参数，应用就返回了三个邮箱混在一起的 20 封——界面上只有每行开头
    // 一个 [QQ邮箱]，用户以为是在看 outlook，其实是全部账号。应用返回的 hint 里本来有提示，
    // 但它是写给模型看的（含 account= 这类内部参数名），不能直接给用户，这里按数据特征自己说一句。
    const srcs = new Set(
      shown
        .filter((it) => isPlain(it) && typeof it.account === 'string' && it.account.trim())
        .map((it) => it.account.trim()),
    );
    if (srcs.size > 1) {
      lines.push(`（以上是 ${srcs.size} 个邮箱合并的结果，方括号里是来源邮箱）`);
    }
    // 闭环里没有「用户回序号」这回事——序号是渲染出来的，模型得自己调工具。
    // 直接说「回复序号」会让它把这句话原样回给用户，或者干脆放弃。
    lines.push(forModel
      ? '（要读某一封或对它做别的操作，调用相应的工具，参数用该行「→」后面的值；序号只是给你看的）'
      : '回复序号可对某一条继续操作。');
    return { text: lines.join('\n'), items };
  }

  if (found && found.list.length === 0) {
    const env = found.envelope || {};
    const hint = env.hint || env.message || env.note;
    return { text: hint ? `「${tool.title || tool.name}」：${hint}` : `「${tool.title || tool.name}」没有数据。` };
  }

  // 非列表：纯文本截断（先把写给模型看的定位信息清掉、把机器信头折叠，再判长度）
  const raw = foldMachineLines(humanize(res.text));
  if (!raw) return { text: `「${tool.title || tool.name}」执行完成，没有返回内容。` };
  if (raw.length <= 900) return { text: raw };
  // 截在行边界上：从中间切断会把一个词劈成两半，看着像乱码
  const cut = raw.lastIndexOf('\n', 900);
  const head = raw.slice(0, cut > 600 ? cut : 900);
  return { text: head + `\n…（共 ${raw.length} 字，已截断）` };
}
