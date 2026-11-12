// 编排层：一段文字进来，一段文字出去。这是整个网关唯一"有脑子"的地方。
//
// 顺序刻意设计成这样，每一步都必须在下一步之前：
//   指令 → 待决状态（确认/选择/补参）→ 本地或AI识别 → 补参 → 风险 → 执行 → 渲染
//
// 为什么不把待决状态放在识别之后：用户在确认阶段回"确认"两个字，
// 如果先走识别，本地索引会把它匹配到某个奇怪的工具上。状态必须最先看。

import { renderMenu } from './router.js';
import { checkRisk, missingArgs, describeParam, coerceArg, parseInlineArgs, prepareArgs, mergeArgs, runTool, renderResult, riskLabel } from './exec.js';
import { chatOnce, agentLoop, SEARCH_TOOL } from './llm.js';
import { isYes, isNo, parseOrdinal } from './session.js';

const MAX_INPUT = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 「把这封大概讲讲」——短句 + 总结类动词。只在上一轮有结果时才起作用，
// 目的是别让这句话被当成一个新请求重新列一遍清单（2026-11-09 实测：
// 用户搜到 1 封旅游邮件后说「总结一下大概内容」，网关回了他 20 封无关邮件）。
const DIGEST_RE = /总结|概括|归纳|摘要|提炼|要点|大概(内容|意思|讲)|讲的?什么|讲一下|讲讲|说说|简单说/;

// 「验证码是多少」「这封写了什么」「一共多少钱」——问的是**内容**，不是清单。
// 这类话如果只回了列表，等于没回答：用户还得再回一个「1」才看得到正文。
// 2026-11-10 实测：「steam登录验证码是多少」回了 10 条清单就停了。
const CONTENT_RE = /验证码|校验码|动态码|激活码|正文|内容|写了?(什么|啥)|说了?(什么|啥)|讲的?(什么|啥)|怎么说的|多少钱|金额|价格|报价|单号|编号|链接/;
// 反过来：这些词说明用户要的就是清单本身，别自作主张替他打开一条。
const LIST_RE = /哪些|清单|列表|几封|多少封|全部|所有|汇总|统计|都有什么/;

// 「从这句话里还能拿什么去搜」——中文没空格，只能靠停用词切。
// 剥掉的是**指令和疑问**那部分，留下的是**实体**（steam、招商银行、发票）。
// 顺序无所谓，用的时候按长度从长到短替换，避免「是不是」被「是」先啃掉半截。
const STOP_WORDS = [
  '帮我', '帮忙', '麻烦', '给我', '替我', '能不能', '可不可以', '可以', '一下',
  '找找', '找', '查查', '查', '搜搜', '搜', '看看', '看', '打开', '读读', '读', '列一下', '列出',
  '那个', '这个', '那封', '这封', '刚才', '之前', '最新', '最近', '现在', '今天', '昨天',
  '哪些', '有几封', '几封', '多少封', '多少', '什么', '啥', '是不是', '有没有', '没有',
  '邮件', '信件', '收件箱', '里面', '正文', '内容', '关于', '消息',
  '是', '的', '了', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '和', '与', '在', '到', '给', '把', '有',
];
const STOP_RE = new RegExp(
  STOP_WORDS.slice().sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

// 摘要提示词。刻意压着不让它发挥：用户在微信里要的是"这封讲了什么"，
// 不是一篇读后感；带 markdown 星号在微信里会原样显示成一堆星号。
const DIGEST_PROMPT = `你在微信里帮用户看一封邮件或一条查询结果，请用 3 到 5 句中文说清要点：
谁发来的、讲的是什么事、要不要用户做什么、有没有时间或金额这类关键信息。
不要复述原文、不要逐行翻译、不要用 markdown、不要加「总结：」这样的前缀。
如果内容里没什么实质信息，就直接说「这封没什么实质内容」。`;

// 识别方式与 AI 用量要跟着「这个工具是怎么被选中的」一路带到落盘那一行。
// 中途会经过「补参数」「二次确认」两个异步跳，meta 必须跟着 pending 一起存，
// 否则用户回一句「确认」之后，日志里就变成「不知道是谁选的」。
function metaFields(meta) {
  const m = meta || {};
  return {
    via: m.via || null,
    provider: m.provider || null,
    model: m.model || null,
    usage: m.usage || null,
  };
}

const HELP_TAIL = [
  '其他指令：',
  '/list 看能做哪些事',
  '/menu 列出全部操作',
  '/status 网关状态',
  '/cancel 取消当前操作',
  '/help 这条说明',
];

// 没有接入任何应用时的统一说法。出厂配置是空的，所以这是很多人的第一屏。
const NO_APP = [
  '还没有接入任何应用。',
  '先在控制台「应用」页添加一个 MCP server 或 CLI 连接器，之后就能在这里直接下指令。',
  '',
  ...HELP_TAIL,
].join('\n');

// 没配模型时的唯一说法。AI 是这里唯一的大脑，没有它就没有"听懂人话"这回事——
// 与其用关键词硬猜（会错着执行），不如直接告诉人去哪儿配。
const NO_AI = [
  '还没有配置 AI 模型，现在只能执行指令。',
  '打开控制台 →「设置」→「AI 模型」→ 添加服务商（填接口地址、模型名、密钥），保存后立刻生效。',
  '',
  ...HELP_TAIL,
].join('\n');

export class Agent {
  constructor({ registry, config, sessions, log, hooks }) {
    this.registry = registry;
    this.config = config;
    this.sessions = sessions;
    this.log = log;
    this.hooks = hooks;   // { send(chatId, text), logCall(record) }
  }

  // 微信消息偶尔会带 "@机器人名 " 前缀，剥掉再解析
  static clean(text) {
    let s = String(text ?? '').replace(/\u2005/g, ' ').trim();
    s = s.replace(/^@\S+\s+/, '');
    return s.slice(0, MAX_INPUT);
  }

  // 「总结一下」「大概讲什么」这类话本身没有对象，全靠上一轮。
  // 只认短句：长句里夹着总结（「把这封总结一下发给张三」）是另一件事，别拦。
  static asksForDigest(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 24) return false;
    return DIGEST_RE.test(s);
  }

  // 这句话是在问某一条的内容，还是只想要一份清单？
  static asksForContent(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (LIST_RE.test(s)) return false;   // 「有哪些」优先当清单，别替他打开一封
    return CONTENT_RE.test(s);
  }

  // 问内容、但这一轮只拿到清单 ⇒ 值得再走一步去打开最新那条。
  // 四种情况不插手：本来就走摘要、已经是在「回序号」那一跳、已经是自动打开那一跳、列表为空。
  static shouldOpenNewest(text, items, meta = {}) {
    if (!items?.length) return false;
    if (meta.digest || meta.via === 'ref' || meta.via === 'auto') return false;
    return Agent.asksForContent(text);
  }

  // 挑时间最新的那一条。全都认不出时间时退回第一条（应用一般按时间倒序给）。
  // 只按顺序取第几条不靠谱：搜「steam」会同时命中一堆购买回执，验证码那封只是恰好排在前面。
  static newestItem(items) {
    if (!items?.length) return null;
    let best = items[0];
    let bestAt = Number.isFinite(best.at) ? best.at : null;
    for (const it of items.slice(1)) {
      if (!Number.isFinite(it.at)) continue;
      if (bestAt === null || it.at > bestAt) { best = it; bestAt = it.at; }
    }
    return best;
  }

  // 从一句话里摘「可能是检索词」的片段。
  // 拉丁词（steam / noreply@github.com）区分度最高，排在前面；中文则剥掉指令词后
  // 取剩下的连续汉字块。不求分得准——它只用来决定「还能换哪个词去搜」。
  static keywords(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return [];
    const out = [];
    for (const m of s.matchAll(/[a-z0-9][a-z0-9._@+-]*[a-z0-9]|[a-z0-9]/g)) {
      const w = m[0].replace(/[._@+-]+$/, '');
      if (w.length >= 2 && !/^\d+$/.test(w)) out.push(w);
    }
    const stripped = s.replace(/[^\u4e00-\u9fff]+/g, ' ').replace(STOP_RE, ' ').replace(/\s+/g, ' ').trim();
    for (const blk of stripped.split(' ')) {
      const t = blk.trim();
      if (t.length >= 2 && t.length <= 12) out.push(t);
    }
    return [...new Set(out)];
  }

  // 搜了个空之后，还能换成什么词再搜。只有带 query 类参数的工具才用得上。
  // 多词查询优先拆开：mailnest 的全文索引是 AND 连接，正文没进索引时
  // 「steam 验证码」这种两词查询必然落空，单搜其中一个反而能命中。
  static altQueries(tool, argv, asked, max = 2) {
    const props = tool?.inputSchema?.properties || {};
    const qkey = ['query', 'q', 'keyword', 'keywords'].find((k) => k in props && k in argv);
    if (!qkey) return [];
    const cur = String(argv[qkey] || '').trim();
    const cand = [];
    if (/\s/.test(cur)) cand.push(...cur.split(/\s+/).filter((w) => w.length >= 2));
    cand.push(...Agent.keywords(asked));
    const seen = new Set([cur.toLowerCase()]);
    const out = [];
    for (const w of cand) {
      const k = String(w).toLowerCase();
      if (k.length < 2 || k.length > 40 || seen.has(k)) continue;
      seen.add(k);
      out.push({ ...argv, [qkey]: w });
      if (out.length >= max) break;
    }
    return out;
  }

  // 命中的多条里挑「最像」的那条，再在像的中挑最新的。
  // 只按时间挑会栽在泛词上：「验证码」会同时命中 GitHub、银行、外卖平台，
  // 最新那封可能根本不是用户在等的那家。原话里还有词（steam）时先按它过滤。
  static bestItem(items, asked) {
    if (!items?.length) return null;
    const words = Agent.keywords(asked);
    if (words.length) {
      const hit = items.filter((it) => {
        const s = String(it.label || '').toLowerCase();
        return words.some((w) => s.includes(w));
      });
      // 一半以上都「像」等于没筛（泛词把整个列表都命中了），这时过滤没意义
      if (hit.length && hit.length < items.length) return Agent.newestItem(hit);
    }
    return Agent.newestItem(items);
  }

  async handle({ chatId, text, contextToken, trigger = 'wechat' }) {
    const raw = Agent.clean(text);
    if (!raw) return;
    // 记下这句话。执行层是异步的（慢操作还会先回执），等结果出来时再回头找原话
    // 就找不到了——而历史里缺了「用户到底问了什么」，下一轮就没法接。
    this.sessions.get(chatId).lastUser = raw;

    const say = async (t) => {
      await this.hooks.send(chatId, t, contextToken);
      return { handled: true };
    };

    // ① 内置指令
    if (raw.startsWith('/')) {
      const cmd = raw.slice(1).split(/\s+/)[0].toLowerCase();
      if (['help', '帮助', '?', '？'].includes(cmd)) return say(this._help());
      if (['list', '命令', '技能'].includes(cmd)) return say(this._list());
      if (['menu', '菜单'].includes(cmd)) {
        const all = require_all(this.registry);
        return say(all.length ? renderMenu(all) : NO_APP);
      }
      if (['status', '状态'].includes(cmd)) return say(this._status());
      if (['cancel', '取消'].includes(cmd)) {
        this.sessions.clearPending(chatId);
        return say('已取消。');
      }
      // 未知指令当普通文本继续往下走，别硬报错
    }

    // ② 待决状态：确认 / 选择 / 补参
    const pending = this.sessions.takePending(chatId);
    if (pending) {
      if (pending.type === 'confirm') {
        if (isYes(raw)) {
          this.sessions.clearPending(chatId);
          return this._run(chatId, pending.toolKey, pending.args || {}, trigger, contextToken, pending.meta || {});
        }
        if (isNo(raw)) {
          this.sessions.clearPending(chatId);
          return say('已取消。');
        }
        // 既不是确认也不是取消：作废旧操作，把这句话当新指令处理
        this.sessions.clearPending(chatId);
      } else if (pending.type === 'pick') {
        const n = parseOrdinal(raw);
        if (n && pending.candidates[n - 1]) {
          this.sessions.clearPending(chatId);
          return this._run(chatId, pending.candidates[n - 1].key, {}, trigger, contextToken);
        }
        if (isNo(raw)) {
          this.sessions.clearPending(chatId);
          return say('已取消。');
        }
        this.sessions.clearPending(chatId);   // 说了别的话，当作新请求
      } else if (pending.type === 'args') {
        // 优先当"补充参数"，其次才当新请求——否则用户填完 "a@b.com" 会被重新识别
        const r = await this._feedArg(chatId, pending, raw, trigger, contextToken);
        if (r) return r;
        this.sessions.clearPending(chatId);
      }
    }

    // ③ 引用上一轮列表：「1」「第2条」
    const ref = this.sessions.pickFromLastList(chatId, raw);
    if (ref) {
      // 上一句是「总结一下」，这里回的序号就是"要总结哪一条"
      const st = this.sessions.get(chatId);
      const wantDigest = !!st.digestNext && Date.now() - st.digestNext.at < 120_000;
      st.digestNext = null;
      const r = await this._openListItem(chatId, ref, trigger, contextToken, wantDigest ? { digest: true } : {});
      if (r) return r;
    }

    // ③b 承接上一轮：「总结一下」「大概讲什么」。
    //
    // 这类话没有自己的对象，全部信息都在上一轮里。交给识别层等于让它凭空猜——
    // 2026-11-09 实测就是在这里出的错：上一轮搜到 1 封旅游邮件，这句「总结一下
    // 大概内容」被理解成"再列一遍邮件"，回了 20 封完全无关的。
    // 上一轮只有一条结果时，指的就是它；直接读它、再让人话摘要。
    if (Agent.asksForDigest(raw) && this.sessions.turnsOf(chatId).length) {
      const st = this.sessions.get(chatId);
      const items = st.lastList?.items || [];
      if (items.length === 1) {
        const r = await this._openListItem(chatId, items[0], trigger, contextToken, { digest: true });
        if (r) return r;
      } else if (items.length > 1) {
        // 上一轮列了好几条，猜不出是哪条——问一句，别自作主张。
        // 记住"这次是要摘要"，用户回「1」时就知道该读正文再概括，而不是原样贴出来。
        st.digestNext = { at: Date.now() };
        return say(`要总结哪一条？回序号就行（1-${items.length}）。`);
      }
      // 上一轮本身就是一段文本（正文、执行结果），没有列表可指——直接摘要它
      const last = this.sessions.turnsOf(chatId).at(-1);
      if (!items.length && last?.kind === 'text' && last.result) {
        const d = await this._digest(last.result);
        if (d?.text) {
          await this.hooks.send(chatId, d.text, contextToken);
          this.sessions.pushTurn(chatId, {
            user: raw, toolTitle: last.toolTitle, args: last.args, result: d.text, kind: 'text',
          });
          return { handled: true };
        }
      }
    }

    // ④ AI 编排：这是唯一的路。前面 ①②③ 都是「协议层」——斜杠命令、回序号、
    //    确认取消，答案空间是枚举的，交给模型反而危险（用户说「取消」，模型可能
    //    理解成"取消订阅"然后去调工具）。语义层的判断一个都不留在本地。
    if (!this._aiReady()) {
      this.log?.info?.('agent', '没配 AI，只执行确定性指令');
      return say(NO_AI);
    }

    const viaLoop = await this._agentTurn(chatId, raw, trigger, contextToken);
    if (viaLoop) return viaLoop;

    // 走到这儿说明闭环彻底没成（没工具 / 超时 / 模型空回复）。
    // 不再回落到"关键词猜一个工具"——那条路会错着执行，代价比"这次没成"大得多。
    return say('这次没弄成，可能是模型那边超时或报错了。换个说法再试一次？');
  }

  // ---- 内部 ---------------------------------------------------------

  // AI 能不能用：只跟「有没有配服务商」有关。以前还有 agent.mode / llm_when 两个
  // 开关表达"本地优先还是 AI 优先"，那是两套大脑并存时的产物，已经一并删掉。
  _aiReady() {
    return this.config.llm?.enabled === true && Object.keys(this.config.llm?.providers || {}).length > 0;
  }

  // 跑一轮闭环。返回 {handled:true} 表示这条消息已经处理完；返回 null 表示
  // 这一路没成（AI 报错、超时、无进展、模型没给出回答）。
  async _agentTurn(chatId, raw, trigger, contextToken) {
    const maxRounds = Math.min(Math.max(Number(this.config.agent?.max_rounds) || 6, 2), 10);
    const maxMs = Math.min(Math.max(Number(this.config.agent?.max_ms) || 45000, 8000), 120000);
    const started = Date.now();

    let r;
    try {
      r = await agentLoop({
        text: raw,
        // 常驻的只有检索工具本身。工具表一个都不进上下文——
        // 22 个工具的 schema 是 4.5k token，接三个应用就 20k，每轮都要带一遍。
        tools: [SEARCH_TOOL],
        catalog: this.registry.catalogText(),
        search: (q, o) => this.registry.search(q, { limit: this.config.routing?.search_limit || 8, ...o }),
        config: this.config,
        history: this._history(chatId),
        maxRounds,
        maxMs,
        execute: (name, args) => this._loopExec(chatId, name, args),
      });
    } catch (e) {
      // 闭环失败绝不能变成"这次没回话"：记一笔原因，让上层给出人话
      this.log?.warn?.('agent', `闭环失败：${e?.message || e}`);
      return null;
    }

    const steps = r.trace?.length || 0;
    this.log?.info?.('agent', `闭环 ${r.rounds} 轮 / ${steps} 次工具 / ${Date.now() - started}ms / 停因=${r.stop}`);

    // 碰到写操作：交回上层的确认流程（风险闸门、二次确认、审计都在那边）
    if (r.stop === 'halt' && r.halted?.tool) {
      return this._begin(chatId, r.halted.tool, raw, trigger, contextToken,
        { via: 'llm', provider: r.provider, model: r.model, usage: r.usage }, r.halted.args || {});
    }

    const answer = String(r.text || '').trim();
    if (!answer) {
      // 没答出来（轮数用尽/超时/原地打转）：把已经查到的摆出来，别让人白等。
      // 只挑成功的那一步——失败那步的文本是「没能完成「读取邮件正文」。执行失败：邮件不存在」，
      // 原样发给用户等于把工具的报错甩到他脸上：看不懂，也不知道下一步能做什么。
      const traces = r.trace || [];
      const last = [...traces].reverse().find((t) => t.text && t.ok !== false);
      if (last) {
        const tail = last.text.length > 600 ? `${last.text.slice(0, 600)}…` : last.text;
        await this.hooks.send(chatId, `这一步没走完，先把我查到的给你：\n${tail}`, contextToken);
        this.sessions.pushTurn(chatId, {
          user: this.sessions.get(chatId)?.lastUser || raw,
          toolTitle: last.tool, args: last.args, result: tail, kind: 'text',
        });
        return { handled: true };
      }
      if (traces.length) {
        // 全失败：说一句人话，别报内部停因（max-rounds / no-progress 这些词跟用户没关系）
        await this.hooks.send(chatId, r.stop === 'timeout'
          ? '这一步花的时间太长，先停在这儿了。等会儿再问一次？'
          : '这次没查成，工具连着报错。换个说法我再试一次？', contextToken);
        return { handled: true };
      }
      return null;
    }

    // 日志里要把「这一步到底调了谁」写清楚：只记一句「AI 闭环（3 步）」，
    // 出了问题没法回看是哪几个工具被串起来的。检索那一次不算业务工具，排除掉。
    const usedTools = (r.trace || []).filter((t) => t.tool && t.tool !== 'search_tools').map((t) => t.tool);
    this._logCall({
      trigger,
      tool: {
        key: 'agent.loop',
        title: `AI 闭环（${steps} 步）${usedTools.length ? `：${usedTools.join('→')}` : ''}`,
        appId: null,
      },
      args: Object.assign({}, ...(r.trace || []).map((t) => t.args || {})),
      ok: true,
      ms: Date.now() - started,
      err: null,
      ...metaFields({ via: 'llm', provider: r.provider, model: r.model, usage: r.usage }),
    });

    try {
      const said = this.sessions.get(chatId).lastUser || '';
      this.sessions.pushTurn(chatId, {
        user: said, toolTitle: 'AI 查询', args: {}, result: answer, kind: 'text',
      });
    } catch { /* 记历史失败不影响这次结果 */ }

    await this.hooks.send(chatId, answer, contextToken);
    return { handled: true };
  }

  // 闭环里的单步执行：只读工具直接跑；写/高危一律 halt，交回确认流程。
  async _loopExec(chatId, name, args) {
    const tool = this.registry.find(name);
    if (!tool) return { ok: false, text: `没有叫「${name}」的工具。只能用清单里有的工具，不要自己编名字。` };
    if (tool.risk !== 'read') return { halt: { tool, args } };

    const argv = prepareArgs(tool, args || {});
    const miss = missingArgs(tool, argv);
    if (miss.length) {
      return { ok: false, text: `参数不完整：还差 ${miss.join('、')}。补上再调一次这个工具。` };
    }
    try {
      const res = await runTool(this.registry, tool, argv, 25000);
      // 两份渲染：一份给模型（每行补 uid/account/folder，它才能正确读正文），
      // 一份给用户（没有内部参数）。只渲染一次的话，要么模型猜不到 uid，
      // 要么 uid 出现在微信里——2026-11-10 线上就是前者：连猜几封都是「邮件不存在」。
      const rendered = renderResult(tool, res, { limit: 10, forModel: true });
      let txt = String(rendered?.text || '');
      // 结果压缩：一封长正文 8000 字，五轮下来会把上下文顶爆。摘要层只留前 2000 字，
      // 够模型判断"这封是不是我要的"，不够的话它还能再调一次读更多。
      if (txt.length > 2000) txt = `${txt.slice(0, 2000)}\n[结果已截断]`;
      const plain = String(renderResult(tool, res, { limit: 10 }).text || '');
      // 闭环里列出来的这批也要记进会话：① 用户看完回答回「2」时能直接定位到这一封，
      // 不用再让模型猜一次；② 不然 lastList 里躺的还是上一次单轮留下的旧列表，
      // 10 分钟内的「1」会打开一封完全不相干的邮件。
      if (rendered?.items?.length) this.sessions.setLastList(chatId, rendered.items, tool.key);
      return { ok: !res.isError, text: txt, visible: plain !== txt ? plain : null, sig: `${name}|${JSON.stringify(argv)}` };
    } catch (e) {
      return { ok: false, text: `调用失败：${e?.message || e}`, sig: `${name}|${JSON.stringify(argv)}` };
    }
  }

  // 举例必须用真实工具，不能写死「查一下未读」——出厂不带任何应用，
  // 接进来的也可能是路由器、下载器，写死邮箱只会让人以为功能不存在。
  _help() {
    const tools = this.registry.tools || [];
    if (!tools.length) return NO_APP;

    // 优先拿只读工具举例：新用户第一次试，最好不要一上来就是高危操作
    const readOnly = tools.filter((t) => t.risk === 'read');
    const picks = (readOnly.length ? readOnly : tools).slice(0, 3);
    const examples = picks.map((t) => `· ${t.title || t.name}`);

    return [
      '直接说你要做什么就行，比如：',
      ...examples,
      '',
      ...HELP_TAIL,
    ].join('\n');
  }

  _list() {
    const apps = this.registry.stats().apps;
    if (!apps.length) return '还没有接入任何应用。';
    const lines = ['已接入：'];
    for (const a of apps) {
      const st = a.status === 'online' ? `${a.toolCount} 个操作` : `离线${a.error ? '（' + a.error.message + '）' : ''}`;
      lines.push(`· ${a.label} — ${st}`);
    }
    lines.push('', '说一句话就能用，或者 /menu 看全部操作。');
    return lines.join('\n');
  }

  _status() {
    const st = this.registry.stats();
    const on = st.apps.filter((a) => a.status === 'online').length;
    const llm = this._aiReady() ? `已配置（默认 ${this.config.llm.default}）` : '未配置（只能执行指令）';
    return [
      `应用 ${on}/${st.apps.length} 在线 · 工具 ${st.toolCount} 个`,
      `AI 模型：${llm}`,
    ].join('\n');
  }

  // 参数是否齐，齐了就走风险检查
  async _begin(chatId, tool, text, trigger, contextToken, meta = {}, aiArgs = {}) {
    // 把「用户这一句原话」钉在 meta 上跟着这一轮走。会话里的 lastUser 是"最近一句"，
    // 慢操作（首次搜索建索引要几秒）期间用户再发一句话，它就被覆盖了——执行完回头
    // 判断"这句是不是在问内容"时，读到的会是别人的话。用本轮自己的原话才不会串。
    meta = { ...meta, asked: String(text || '').slice(0, 60) };
    // 参数有两个来源：模型从这句话里读出来的（aiArgs），和用户按模板敲的（「关键词：旅游」）。
    // 早先只用了后者，于是「帮我找一封有关旅游的邮件」明明带着关键词，却被追问「关键词是什么：
    // 一句话里并没有『关键词：』这种模板——模型读对了也没用上。现在两个都收。
    const merged = mergeArgs(tool, aiArgs, parseInlineArgs(tool, text || ''));
    const miss = missingArgs(tool, merged);
    if (miss.length) {
      this.sessions.setPending(chatId, { type: 'args', toolKey: tool.key, args: merged, missing: miss, meta });
      await this.hooks.send(chatId, `要执行「${tool.title || tool.name}」，还差一个${describeParam(tool, miss[0])}：`, contextToken);
      return { handled: true };
    }
    return this._guard(chatId, tool, merged, trigger, contextToken, meta);
  }

  async _feedArg(chatId, pending, raw, trigger, contextToken) {
    const tool = this.registry.find(pending.toolKey);
    if (!tool) return null;
    const name = pending.missing[0];
    if (!name) return null;
    const args = { ...pending.args, [name]: coerceArg(tool, name, raw) };
    const miss = missingArgs(tool, args);
    if (miss.length) {
      this.sessions.setPending(chatId, { type: 'args', toolKey: tool.key, args, missing: miss, meta: pending.meta });
      await this.hooks.send(chatId, `还差一个${describeParam(tool, miss[0])}：`, contextToken);
      return { handled: true };
    }
    this.sessions.clearPending(chatId);
    return this._guard(chatId, tool, args, trigger, contextToken, pending.meta || {});
  }

  // 风险闸门
  async _guard(chatId, tool, args, trigger, contextToken, meta) {
    const app = this.registry.getApp(tool.appId);
    const v = checkRisk(tool, app?.cfg, this.config.gateway);

    if (v.verdict === 'denied') {
      await this.hooks.send(chatId, v.reason, contextToken);
      this._logCall({ trigger, tool, args, ok: false, ms: 0, err: '被网关拦截', ...metaFields(meta) });
      return { handled: true };
    }
    if (v.verdict === 'confirm') {
      const ttl = this.config.gateway.confirm_ttl || 60;
      this.sessions.setPending(chatId, { type: 'confirm', toolKey: tool.key, args, meta });
      const preview = Object.keys(args).length
        ? `参数：${Object.entries(args).map(([k, x]) => `${k}=${String(x).slice(0, 40)}`).join('，')}\n`
        : '';
      await this.hooks.send(
        chatId,
        `${v.reason}，执行前确认一下：\n${preview}确认执行请回复「确认」，${ttl} 秒内有效；回复其他内容视为取消。`,
        contextToken,
      );
      return { handled: true };
    }
    return this._run(chatId, tool.key, args, trigger, contextToken, meta);
  }

  async _run(chatId, toolKey, args, trigger, contextToken, meta = {}) {
    const tool = this.registry.find(toolKey);
    if (!tool) {
      await this.hooks.send(chatId, '这个操作现在不可用了（应用可能被移除）。', contextToken);
      return { handled: true };
    }
    // 最后一道整形：把 schema 里没有的键去掉、按类型转一遍。走到这里还可能因为
    // 「列表项只带了 uid，而详情工具还要一个附件序号」这类情况缺参数——缺了就问，
    // 别硬传。硬传的结果是应用抛「Invalid input: expected number, received NaN」，
    // 用户只会看到一串内部报文，还以为是坏了。
    const argv = prepareArgs(tool, args || {});
    const miss = missingArgs(tool, argv);
    if (miss.length) {
      this.sessions.setPending(chatId, { type: 'args', toolKey: tool.key, args: argv, missing: miss, meta });
      await this.hooks.send(chatId, `要执行「${tool.title || tool.name}」，还差一个${describeParam(tool, miss[0])}：`, contextToken);
      return { handled: true };
    }

    const app = this.registry.getApp(tool.appId);
    const timeoutMs = (app?.cfg?.timeout || this.config.gateway.call_timeout || 20) * 1000;
    const asyncAfter = Math.max(1, this.config.gateway.async_after || 10) * 1000;

    const started = Date.now();
    const p = runTool(this.registry, tool, argv, timeoutMs);

    // 慢操作先回执：微信侧长轮询 35 秒，工具跑 3 分钟时不能让人干等
    const slow = await Promise.race([p.then(() => false), sleep(Math.min(asyncAfter, timeoutMs)).then(() => true)]);
    if (slow) {
      await this.hooks.send(chatId, `「${tool.title || tool.name}」还在跑，完了我发结果过来。`, contextToken);
    }

    const res = await p;
    let usedArgs = argv;
    let rendered = renderResult(tool, res);

    // 搜了个空，先别急着回「没搜到」。
    // 模型常把话里最显眼的词填成关键词（问「steam 验证码是多少」填「验证码」），
    // 而泛词基本只能靠正文命中——正文还没下载进索引，就必然落空。
    // 用户原话里通常还有一个更强的词（steam），换它再搜一次往往直接命中。
    // 最多补两次，命中就停；失败时仍用原查询的结果，文案才对得上用户问的那句。
    let swapped = null;
    if (!res.isError && !rendered.items?.length) {
      const asked = String(meta.asked || this.sessions.get(chatId)?.lastUser || '');
      for (const alt of Agent.altQueries(tool, argv, asked)) {
        const r2 = await runTool(this.registry, tool, alt, timeoutMs);
        const rd2 = renderResult(tool, r2);
        if (rd2.items?.length) {
          const k = Object.keys(alt).find((x) => alt[x] !== argv[x]);
          swapped = { from: argv[k], to: alt[k] };
          usedArgs = alt;
          rendered = rd2;
          this.log?.info?.('open', `搜「${argv[k]}」没结果，换「${alt[k]}」命中 ${rd2.items.length} 条`);
          break;
        }
      }
    }
    // 换过词就得交代清楚，否则用户以为这是「验证码」搜出来的。
    const note = swapped && rendered.items?.length
      ? `没搜到带「${swapped.from}」的邮件，换成「${swapped.to}」找到 ${rendered.items.length} 封：`
      : null;
    if (note) meta = { ...meta, note };

    // 记住列表项，供「1」引用下一步
    if (rendered.items?.length) {
      this.sessions.setLastList(chatId, rendered.items, tool.key);
      const opened = await this._maybeOpenNewest(chatId, rendered, trigger, contextToken, meta);
      if (opened) {
        // 清单这一跳也记一笔。只记「读了正文」的话，事后查日志看不出它为什么读这封。
        this._logCall({
          trigger,
          tool,
          args: usedArgs,
          ok: !res.isError,
          ms: res.ms || Date.now() - started,
          err: null,
          ...metaFields(meta),
        });
        return opened;
      }
    } else if (/共 \d+ 条/.test(rendered.text || '')) {
      // 清单出来了却没有可引用的条目：说明返回结构里认不出 id（uid/id/name…）。
      // 这时用户回「1」也打不开，得先知道是这个原因，而不是"自动跳没生效"。
      this.log?.warn?.('open', `列出了清单但没认出发起下一步的 id：${String(rendered.text).slice(0, 100).replace(/\n/g, ' ')}`);
    }

    // 「总结一下」：拿到正文后让人话摘要，替换掉那一大段原文。
    // 只在没有列表项时才做——列了 8 条邮件再做摘要，等于把清单吞掉。
    // 摘要失败就照原文发，绝不因为 AI 挂了让用户什么都看不到。
    let out = rendered.text;
    if (meta.digest && !rendered.items?.length) {
      const d = await this._digest(rendered.text);
      if (d?.text) {
        out = d.text;
        // 摘要本身也是一次 AI 调用，token 要算进这一轮——否则日志里这行
        // 显示"没花 token"，用户会以为摘要不要钱。
        meta = { ...meta, usage: d.usage || null, provider: meta.provider || d.provider, model: meta.model || d.model };
      }
    }

    // 自动打开某一条时先交代一句——否则用户不知道这封是怎么冒出来的。
    // 换过关键词的情况也要说，不然用户以为这是「验证码」搜出来的。
    if (meta.lead) out = `${meta.lead}\n${out}`;
    else if (meta.note) out = `${meta.note}\n${out}`;

    // 审计与历史都在推送之前落定。反过来的话，「结果已发出」和「记录已写好」
    // 之间有一个 await 的窗口，看日志的人（和测试）会读到上一条。
    this._logCall({
      trigger,
      tool,
      args: usedArgs,
      ok: !res.isError,
      ms: res.ms || Date.now() - started,
      err: res.isError ? String(res.text || '').slice(0, 120) : null,
      ...metaFields(meta),
    });

    // 记一轮对话。存的是**给用户看的那份**（可能是摘要），下一轮接话时
    // 模型看到的就是用户此刻看到的东西，两边不会对不上。
    //
    // 「确认」「1」这类回话本身没有信息量，记进历史只会让下一轮模型看不懂
    // 上下文，所以沿用上一条真正说事的话。
    try {
      const said = this.sessions.get(chatId).lastUser || '';
      const prev = this.sessions.turnsOf(chatId).at(-1);
      const bare = isYes(said) || isNo(said) || parseOrdinal(said) !== null;
      this.sessions.pushTurn(chatId, {
        user: bare && prev?.user ? prev.user : said,
        toolTitle: tool.title || tool.name,
        args: usedArgs,
        result: out,
        kind: rendered.items?.length ? 'list' : 'text',
      });
    } catch { /* 记历史失败不影响这次结果 */ }

    const header = slow
      ? `「${tool.title || tool.name}」完成（${Date.now() - started} ms）\n`
      : '';
    await this.hooks.send(chatId, header + out, contextToken);
    return { handled: true };
  }

  // 问的是内容，却只拿到一份清单——再走一步把**最新**那条打开。
  // 模型这一步没走错：读正文的工具要 uid，它那会儿还没有，只能先搜。
  // 缺的是「搜完接着打开」这一跳，以前要用户自己回一个「1」。
  async _maybeOpenNewest(chatId, rendered, trigger, contextToken, meta = {}) {
    const items = rendered?.items || [];
    // 优先用这一轮自己的原话（见 _begin）；会话里的 lastUser 只作兜底。
    const asked = String(meta.asked || this.sessions.get(chatId)?.lastUser || '');
    if (!Agent.shouldOpenNewest(asked, items, meta)) {
      // 留一条能被 docker logs 看见的判断依据：下次"问内容却只给清单"时，
      // 不必再靠猜——直接看这句话被当成了什么。
      this.log?.info?.('open', `没自动打开：${JSON.stringify(asked.slice(0, 30))} · 列表 ${items.length} 条 · via=${meta.via || '-'}${meta.digest ? ' · 摘要' : ''}`);
      return null;
    }
    // 挑「最像」的那条，像的多条里再取最新的。
    // 以前只按时间挑，泛词会栽：搜「验证码」同时命中 GitHub、银行、外卖平台，
    // 最新那封可能根本不是用户在等的那家——原话里还有 steam 就该先按它过滤。
    const target = Agent.bestItem(items, asked);
    if (!target) return null;
    const when = target.when ? `（${target.when}）` : '';
    // 只有一条时不必说「找到 1 条，先打开最近这条」——绕。
    const lead = (meta.note ? `${meta.note}\n` : '') + (items.length > 1
      ? `找到 ${items.length} 条，先打开最近这条${when}：`
      : `打开这条${when}：`);
    // via 标成 auto 而不是沿用「回序号」的 ref：日志和界面上要能一眼分开
    // 「网关自己替你打开了」和「你回了一个 1」。以前两者都是 ref，看起来永远是"列表"。
    return this._openListItem(chatId, target, trigger, contextToken, { lead, via: 'auto' });
  }

  // 「1」→ 用上一轮的 id 调"详情类"工具
  _openListItem(chatId, ref, trigger, contextToken, extraMeta = {}) {
    const listToolKey = this.sessions.get(chatId).lastList?.toolKey;
    if (!listToolKey) return null;
    const listTool = this.registry.find(listToolKey);
    if (!listTool) return null;

    // 找同应用里名字像"读取详情"的只读工具，且必填项里含有列表项的 id 字段名。
    //
    // 但必须只挑「我们凑得出参数」的那个：同一个应用常同时有 read_message（只要 uid）
    // 和 read_attachment（uid + 第几个附件），两者都叫 read*，按 key 排序附件那个在前。
    // 2026-11-09 实测就是这样把用户的「1」当成「读附件」：uid 有、序号没有，应用侧
    // z.coerce.number(undefined) 得到 NaN，回了一句 expected number, received NaN。
    const brothers = this.registry.tools.filter((t) => t.appId === listTool.appId && t.key !== listTool.key);
    const cands = brothers.filter((t) => {
      if (t.risk !== 'read') return false;
      if (!/read|get|detail|show|view|fetch|info|open/i.test(t.name)) return false;
      return (t.inputSchema?.required || []).includes(ref.argKey);
    });

    // 手里能填的键：列表项的 id 本身 + 它自带的定位信息（跨账号邮件的 account）。
    // 必填项全部落在这一组里才敢调，少一个就换下一个候选。
    const known = new Set([ref.argKey, ...Object.keys(ref.extra || {})]);
    const usable = cands.filter((t) => (t.inputSchema?.required || []).every((k) => known.has(k)));
    if (!usable.length) return null;

    // 都可用时，选和列表工具同名的那个（list_messages → read_message），
    // 不要跳到隔壁的「读附件」或「读草稿」上——它们只是碰巧也带 uid。
    const words = (n) => String(n || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const listWords = words(listTool.name);
    const detail = usable
      .map((t) => ({ t, shared: words(t.name).filter((w) => listWords.includes(w)).length }))
      .sort((a, b) => b.shared - a.shared || a.t.key.localeCompare(b.t.key))[0].t;

    const primary = (detail.inputSchema?.required || [])[0] || ref.argKey;
    // 列表项可能自带定位参数（跨账号邮件要同时给 uid 和 account）。
    // 只传详情工具 schema 里真的有的键——不然多塞一个参数会被应用当成非法入参。
    const props = detail.inputSchema?.properties || {};
    const extra = {};
    for (const [k, v] of Object.entries(ref.extra || {})) {
      if (k in props) extra[k] = v;
    }
    const args = { ...extra, [primary]: ref.value };
    return this._run(chatId, detail.key, args, trigger, contextToken, { via: 'ref', ...extraMeta })
      .then(() => ({ handled: true }));
  }

  // 最近几轮对话，交给识别层。原话 + 工具 + 结果开头一截。
  // 参数也带上：模型知道上一轮是按「旅游」搜的，这句「再搜搜合同」才知道往哪加词。
  _history(chatId) {
    const turns = this.sessions.turnsOf(chatId);
    const out = [];
    for (const t of turns) {
      out.push({ role: 'user', content: String(t.user || '') });
      const args = t.args && Object.keys(t.args).length ? `，参数 ${JSON.stringify(t.args).slice(0, 160)}` : '';
      const did = t.toolTitle ? `（调用了「${t.toolTitle}」${args}）` : '';
      out.push({
        role: 'assistant',
        content: `${did}\n结果：${String(t.result || '').slice(0, 700)}`.trim(),
      });
    }
    return out;
  }

  // 把一段结果说成人话。失败返回 null，调用方照原样发。
  async _digest(content) {
    if (!this.config.llm?.enabled) return null;
    const text = String(content || '').trim();
    if (!text) return null;
    try {
      const r = await chatOnce({
        config: this.config,
        maxTokens: Math.min(Number(this.config.llm.max_tokens) || 400, 800),
        messages: [
          { role: 'system', content: DIGEST_PROMPT },
          { role: 'user', content: text.slice(0, 4000) },
        ],
      });
      const out = String(r.text || '').trim();
      return out ? { text: out, usage: r.usage || null, provider: r.provider, model: r.model } : null;
    } catch (e) {
      this.log?.warn?.('digest', `摘要没做出来，按原文发：${e?.message || e}`);
      return null;
    }
  }

  _logCall(rec) {
    try { this.hooks.logCall?.({ ...rec, at: Date.now() }); } catch { /* 日志失败不影响主流程 */ }
  }
}

// /menu 时给全量，按应用分组会更有用，但这里先平铺——数量不大时反而更好扫
function require_all(registry) {
  const RISK = { read: 0, write: 1, high: 2 };
  return [...registry.tools]
    .sort((a, b) => (RISK[a.risk] - RISK[b.risk]) || a.key.localeCompare(b.key))
    .slice(0, 20)
    .map((t) => ({ key: t.key, label: `${t.title || t.name}（${riskLabel(t.risk)}）`, appLabel: t.appLabel, risk: t.risk }));
}
