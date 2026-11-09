// 会话状态：让"1"、"确认"、"发给谁？"这类多轮交互成为可能。
//
// 微信是纯文本管道，没有按钮、没有表单、没有上下文窗口。所以"一句话说不全"
// 这件事只能靠多轮问答补——而多轮问答必须有状态，否则第二轮就不知道该接哪句话。
//
// 三种待决状态（互斥，同时只能有一个）：
//   confirm —— 高危操作等"确认"（有 TTL，过期自动作废，防止半夜翻到旧消息误触）
//   pick    —— 候选菜单等数字（对应"1. 查状态  2. 看设备"）
//   args    —— 参数没给全，正在一项项问
//
// 另有 lastList：记住上一轮列表的每一项对应哪个 id，供"1"、"第 2 封"这类引用。
// 以及 turns：最近几轮"用户说了什么 / 调了哪个工具 / 回了什么"，交给识别层当上下文。
// 没有这个，微信里每句话都是孤立的——「总结一下大概内容」会被当成一个全新的请求。

// 留几轮：微信里「总结一下」→「再详细点」→「翻成英文」能连着追三层就够用了，
// 再往上翻只会把无关的旧话题也塞给模型，反而更容易跑偏。
const MAX_TURNS = 3;

const DEFAULT_TTL = {
  confirm: 60_000,   // 由 config.gateway.confirm_ttl 覆盖
  pick: 5 * 60_000,
  args: 5 * 60_000,
};

export class SessionStore {
  constructor({ log, confirmTtl = 60 } = {}) {
    this.map = new Map();
    this.log = log;
    // TTL 放在实例上，设置页改 confirm_ttl 时能立即生效（不用重启）
    this.ttl = { ...DEFAULT_TTL, confirm: confirmTtl * 1000 };
  }

  set confirmTtl(sec) {
    this.ttl.confirm = Math.max(10, Number(sec) || 60) * 1000;
  }

  get(chatId) {
    let s = this.map.get(chatId);
    if (!s) {
      s = { chatId, pending: null, lastList: null, lastTool: null, turns: [], lastAt: Date.now() };
      this.map.set(chatId, s);
    }
    return s;
  }

  // 取待决状态，顺手做过期判定——所有消费方都经过这里，过期就不会漏
  takePending(chatId) {
    const s = this.get(chatId);
    if (!s.pending) return null;
    if (Date.now() - s.pending.at > (this.ttl[s.pending.type] || 60_000)) {
      this.log?.debug('session', `待决状态过期：${s.pending.type}`);
      s.pending = null;
      return null;
    }
    return s.pending;
  }

  setPending(chatId, pending) {
    const s = this.get(chatId);
    s.pending = { ...pending, at: Date.now() };
    s.lastAt = Date.now();
    return s.pending;
  }

  clearPending(chatId) {
    const s = this.get(chatId);
    s.pending = null;
  }

  setLastList(chatId, items, toolKey) {
    const s = this.get(chatId);
    s.lastList = { items, toolKey, at: Date.now() };
  }

  // 引用上一轮列表：「1」「第2个」「第二条」
  pickFromLastList(chatId, text) {
    const s = this.get(chatId);
    if (!s.lastList || !s.lastList.items?.length) return null;
    if (Date.now() - s.lastList.at > 10 * 60_000) return null;
    const n = parseOrdinal(text);
    if (n === null) return null;
    const item = s.lastList.items[n - 1];
    return item || null;
  }

  // 记一轮对话。只留能读懂的最小信息：原话、工具、结果开头一截。
  // 不存完整结果——正文动辄几十 KB，存下来会把内存和 token 都撑爆。
  pushTurn(chatId, turn) {
    const s = this.get(chatId);
    const list = Array.isArray(s.turns) ? s.turns : (s.turns = []);
    list.push({ ...turn, at: Date.now() });
    if (list.length > MAX_TURNS) list.splice(0, list.length - MAX_TURNS);
    s.lastAt = Date.now();
    return list;
  }

  // 供识别层使用的历史。超过 TTL 的丢掉——否则一小时前那句「总结一下」
  // 会把现在完全无关的请求带偏。
  turnsOf(chatId, { ttl = 10 * 60_000 } = {}) {
    const s = this.get(chatId);
    const list = Array.isArray(s.turns) ? s.turns : [];
    return list.filter((t) => Date.now() - t.at <= ttl);
  }

  reset(chatId) {
    this.map.delete(chatId);
  }
}

// 「1」「１」「第一」「第2个」「第二条」「#3」都认
export function parseOrdinal(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let m = s.match(/^[#＃]?\s*([0-9０-９]{1,2})\s*[.、)）:：]?$/);
  if (m) {
    const n = Number(m[1].replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)));
    return n >= 1 && n <= 50 ? n : null;
  }
  m = s.match(/^第\s*([0-9０-９]{1,2}|[一二三四五六七八九十])\s*(个|条|封|项)?$/);
  if (m) {
    const raw = m[1];
    const n = /^[0-9０-９]+$/.test(raw)
      ? Number(raw.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)))
      : map[raw];
    return n >= 1 && n <= 50 ? n : null;
  }
  return null;
}

const YES = /^(确认|确定|是的?|对|好|好的|可以|执行|继续|嗯|ok|okay|y|yes|是)$/i;
const NO = /^(取消|不用|算了|不要|否|n|no|停止|退出)$/i;

export function isYes(text) {
  return YES.test(String(text || '').trim());
}

export function isNo(text) {
  return NO.test(String(text || '').trim());
}
