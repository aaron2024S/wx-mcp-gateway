// 编排层：一段文字进来，一段文字出去。这是整个网关唯一"有脑子"的地方。
//
// 顺序刻意设计成这样，每一步都必须在下一步之前：
//   指令 → 待决状态（确认/选择/补参）→ 本地或AI识别 → 补参 → 风险 → 执行 → 渲染
//
// 为什么不把待决状态放在识别之后：用户在确认阶段回"确认"两个字，
// 如果先走识别，本地索引会把它匹配到某个奇怪的工具上。状态必须最先看。

import { route, renderMenu } from './router.js';
import { checkRisk, missingArgs, describeParam, coerceArg, parseInlineArgs, runTool, renderResult, riskLabel } from './exec.js';
import { isYes, isNo, parseOrdinal } from './session.js';

const MAX_INPUT = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async handle({ chatId, text, contextToken, trigger = 'wechat' }) {
    const raw = Agent.clean(text);
    if (!raw) return;

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
      const r = await this._openListItem(chatId, ref, trigger, contextToken);
      if (r) return r;
    }

    // ④ 识别
    const decision = await route(raw, { registry: this.registry, config: this.config });

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
      return this._begin(chatId, decision.tool, raw, trigger, contextToken, meta);
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
  async _begin(chatId, tool, text, trigger, contextToken, meta = {}) {
    // 用户可能在句子里直接给了参数（「发给 a@b.com 主题 周会 内容 …」），
    // 能抠出来就先抠，抠不出来才逐项问
    const merged = parseInlineArgs(tool, text || '');
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
    const app = this.registry.getApp(tool.appId);
    const timeoutMs = (app?.cfg?.timeout || this.config.gateway.call_timeout || 20) * 1000;
    const asyncAfter = Math.max(1, this.config.gateway.async_after || 10) * 1000;

    const started = Date.now();
    const p = runTool(this.registry, tool, args, timeoutMs);

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
    }

    const header = slow
      ? `「${tool.title || tool.name}」完成（${Date.now() - started} ms）\n`
      : '';
    await this.hooks.send(chatId, header + rendered.text, contextToken);

    this._logCall({
      trigger,
      tool,
      args,
      ok: !res.isError,
      ms: res.ms || Date.now() - started,
      err: res.isError ? String(res.text || '').slice(0, 120) : null,
      ...metaFields(meta),
    });
    return { handled: true };
  }

  // 「1」→ 用上一轮的 id 调"详情类"工具
  _openListItem(chatId, ref, trigger, contextToken) {
    const listToolKey = this.sessions.get(chatId).lastList?.toolKey;
    if (!listToolKey) return null;
    const listTool = this.registry.find(listToolKey);
    if (!listTool) return null;

    // 找同应用里名字像"读取详情"的只读工具，且必填项里含有列表项的 id 字段名
    const brothers = this.registry.tools.filter((t) => t.appId === listTool.appId && t.key !== listTool.key);
    const detail = brothers.find((t) => {
      if (t.risk !== 'read') return false;
      if (!/read|get|detail|show|view|fetch|info|open/i.test(t.name)) return false;
      const req = t.inputSchema?.required || [];
      return req.includes(ref.argKey);
    });
    if (!detail) return null;

    const primary = (detail.inputSchema?.required || [])[0] || ref.argKey;
    const args = { [primary]: ref.value };
    return this._run(chatId, detail.key, args, trigger, contextToken, { via: 'ref' }).then(() => ({ handled: true }));
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
