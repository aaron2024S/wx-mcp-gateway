// 编排层：一段文字进来，一段文字出去。这是整个网关唯一"有脑子"的地方。
//
// 顺序刻意设计成这样，每一步都必须在下一步之前：
//   指令 → 待决状态（确认/选择/补参）→ 本地或AI识别 → 补参 → 风险 → 执行 → 渲染
//
// 为什么不把待决状态放在识别之后：用户在确认阶段回"确认"两个字，
// 如果先走识别，本地索引会把它匹配到某个奇怪的工具上。状态必须最先看。

import { route, renderMenu } from './router.js';
import { checkRisk, missingArgs, describeParam, coerceArg, parseInlineArgs, prepareArgs, mergeArgs, runTool, renderResult, riskLabel } from './exec.js';
import { chatOnce } from './llm.js';
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
    score: m.score ?? null,
    provider: m.provider || null,
    model: m.model || null,
    usage: m.usage || null,
    // 开了「总是问 AI」但 AI 没接上时，这里留着原文原因；界面据此显示"降级"
    aiError: m.aiError || null,
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
  '先在控制台「应用」页添加一个 MCP server，之后就能在这里直接下指令。',
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
  // 三种情况不插手：本来就走摘要（摘要流程自己会读正文）、已经是「回序号」那一跳、列表为空。
  static shouldOpenNewest(text, items, meta = {}) {
    if (!items?.length) return false;
    if (meta.digest || meta.via === 'ref') return false;
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

    // ④ 识别（带上最近几轮，模型才知道「总结一下」指的是什么）
    const history = this._history(chatId);
    const decision = await route(raw, { registry: this.registry, config: this.config, history });

    if (decision.kind === 'say') return say(decision.text);
    if (decision.kind === 'call') {
      // 落到容器日志里留一条：界面上的"降级"徽章只有鼠标悬停才看得到原文，
      // 而"为什么没走 AI"经常要靠 docker logs 才能查清（key 过期、超时）。
      if (decision.aiError) this.log?.warn?.('route', `AI 没接上，已回落本地：${decision.aiError}`);
      // 只带「这次是谁认的 + 花了多少」，不要把整个 decision（含工具 schema）塞进会话里
      const meta = {
        via: decision.via,
        score: decision.score,
        provider: decision.provider,
        model: decision.model,
        usage: decision.usage,
        aiError: decision.aiError || null,
      };
      return this._begin(chatId, decision.tool, raw, trigger, contextToken, meta, decision.args || {});
    }

    // menu
    const cands = decision.candidates || [];
    if (!cands.length) {
      return say('现在没有可用的操作——应用可能都离线了，去控制台看一眼。');
    }
    this.sessions.setPending(chatId, { type: 'pick', candidates: cands });
    return say(renderMenu(cands, decision.note));
  }

  // ---- 内部 ---------------------------------------------------------

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
    const llm = this.config.llm?.enabled ? `已启用（默认 ${this.config.llm.default}）` : '未启用（纯本地匹配）';
    return [
      `应用 ${on}/${st.apps.length} 在线 · 工具 ${st.toolCount} 个`,
      `AI 路由：${llm}`,
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
    const rendered = renderResult(tool, res);

    // 记住列表项，供「1」引用下一步
    if (rendered.items?.length) {
      this.sessions.setLastList(chatId, rendered.items, tool.key);
      const opened = await this._maybeOpenNewest(chatId, rendered, trigger, contextToken, meta);
      if (opened) {
        // 清单这一跳也记一笔。只记「读了正文」的话，事后查日志看不出它为什么读这封。
        this._logCall({
          trigger,
          tool,
          args: argv,
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
    if (meta.lead) out = `${meta.lead}\n${out}`;

    // 审计与历史都在推送之前落定。反过来的话，「结果已发出」和「记录已写好」
    // 之间有一个 await 的窗口，看日志的人（和测试）会读到上一条。
    this._logCall({
      trigger,
      tool,
      args: argv,
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
        args: argv,
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
    const target = Agent.newestItem(items);
    if (!target) return null;
    const when = target.when ? `（${target.when}）` : '';
    // 只有一条时不必说「找到 1 条，先打开最近这条」——绕。
    const lead = items.length > 1
      ? `找到 ${items.length} 条，先打开最近这条${when}：`
      : `打开这条${when}：`;
    return this._openListItem(chatId, target, trigger, contextToken, { lead });
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
