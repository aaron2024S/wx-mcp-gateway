// 工具索引：从各应用的 tools/list **现场派生**，而不是手写命令表。
//
// 这一层是「加应用要不要改本应用」的答案所在：
//   加一个应用 = 配置里加一段 url → 启动/热重载时自动拉 tools/list → 索引重建。
//   代码一行不动，镜像不用重发。
//
// 搜索信号按可信度分三档：
//   1) 配置里手写的 aliases（最高）——第三方 server 描述写得太烂时的补救
//   2) 工具的 name / title（title 通常是中文短句，区分度最高）
//   3) description 全文（信息最全，但噪声也最多）
// 用 idf 加权：越是"每个工具描述里都有"的词（如「邮件」「列表」）权重越低，
// 这样用户说「未读」能命中 list_messages，而不是被一堆含「邮件」的工具平分。

import { McpClient, McpError } from './mcp.js';
import { resolveProvider } from './config.js';

const CJK = /[\u4e00-\u9fff]/;

// 通用中文停用词（语气、疑问、介词）。**与业务无关**，不随应用变化，
// 所以内置成常量而不是配置项。它们如果留在 query 里，会把真正的关键词稀释掉：
// 「有哪些邮箱」里的「有哪些」对定位工具毫无贡献。
const STOP = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '是', '有', '没',
  '我', '你', '他', '她', '它', '们', '咱', '咱',
  '帮', '请', '要', '想', '能', '会', '可以', '麻烦',
  '一下', '一个', '什么', '怎么', '怎样', '哪些', '哪个', '多少',
  '这个', '那个', '这些', '那些', '现在', '然后', '顺便',
  '就', '还', '都', '也', '再', '又', '很', '太',
  '给', '把', '被', '让', '从', '到', '在', '和', '与', '或', '对', '向',
  '个', '次', '下', '上', '里', '中',
]);

const RISK_ORDER = { read: 0, write: 1, high: 2 };

// 中英混合分词：中文取一元 + 二元，英文/数字取 2 字符以上
export function tokenize(s) {
  const out = new Set();
  const text = String(s || '').toLowerCase();
  for (const m of text.matchAll(/[a-z][a-z0-9_]{1,}/g)) out.add(m[0]);
  for (const seg of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      const bi = i + 1 < seg.length ? seg.slice(i, i + 2) : '';
      if (!STOP.has(ch)) out.add(ch);
      if (bi && !STOP.has(bi)) out.add(bi);
    }
  }
  return out;
}

// 从 title 自动派生「动作词」别名：中文工具 title 几乎都是「动词+名词」
// （删除邮件 / 搜索邮件 / 发送邮件），前 1~2 字就是用户会说的那个动词。
// 这让「删」「搜」「发」这类单字命令能命中，而人工一个字都不用写。
function deriveTitleAliases(title) {
  const t = String(title || '').trim();
  if (t.length < 2) return [];
  const out = [t.slice(0, 2)];
  if (t.length >= 3) out.push(t.slice(0, 1));
  return out.filter((a) => a.length >= 1 && !STOP.has(a));
}

// 把工具声明推导成风险等级。应用自报的 annotations 不全可信，所以这只是"默认值"，
// 真正的放行判断还有 app.allow_risk 和 gateway.confirm_risk 两道兜底（见 exec 层）。
function deriveRisk(tool, overrides) {
  if (overrides && overrides[tool.name]) return overrides[tool.name];
  const a = tool.annotations || {};
  if (a.destructiveHint === true) return 'high';
  if (a.readOnlyHint === true) return 'read';
  return 'write';
}

export class Registry {
  constructor(config) {
    this.config = config;
    this.apps = new Map();     // id -> { cfg, client, status, error, lastAt, protocolVersion, serverInfo }
    this.tools = [];           // 扁平工具列表
    this._df = new Map();      // token -> 文档频率（跨工具）
    this._builtAt = 0;
  }

  getApp(id) {
    return this.apps.get(id);
  }

  // 连一个应用：初始化 + 拉工具。失败不抛，记在 status 里（一个应用离线不能连坐）
  async refreshApp(appCfg) {
    const timeout = (appCfg.timeout || this.config.gateway.call_timeout) * 1000;
    const entry = {
      cfg: appCfg,
      client: null,
      status: 'offline',
      error: null,
      lastAt: Date.now(),
      protocolVersion: null,
      serverInfo: null,
      toolCount: 0,
    };
    try {
      const c = new McpClient({
        url: appCfg.url,
        token: appCfg.auth?.token || '',
        timeout,
        headers: appCfg.headers || {},
        id: appCfg.id,
      });
      const init = await c.initialize();
      const { tools } = await c.listTools();
      entry.client = c;
      entry.protocolVersion = init.protocolVersion;
      entry.serverInfo = init.serverInfo;
      entry.toolCount = tools.length;
      entry.status = 'online';
      entry.rawTools = tools;
      this.apps.set(appCfg.id, entry);
      this._build();
      return entry;
    } catch (e) {
      entry.error = e instanceof McpError
        ? { kind: e.kind, message: e.message, detail: e.detail }
        : { kind: 'unknown', message: e?.message || String(e) };
      // 离线时保留上次的工具快照（如果之前连上过），只把状态标记成离线
      const prev = this.apps.get(appCfg.id);
      if (prev?.rawTools?.length) {
        entry.rawTools = prev.rawTools;
        entry.toolCount = prev.toolCount;
      }
      this.apps.set(appCfg.id, entry);
      this._build();
      return entry;
    }
  }

  async refreshAll() {
    const results = [];
    for (const app of this.config.apps || []) {
      results.push(await this.refreshApp(app));
    }
    return results;
  }

  // 应用列表变了之后的增量同步：只在「地址/令牌/超时」变了时才重连，
  // 只改 allow_risk 或别名不该把长轮询打断一次。
  async syncApps(apps) {
    for (const id of [...this.apps.keys()]) {
      if (!apps.some((a) => a.id === id)) {
        this.apps.delete(id);
        this._build();
      }
    }
    const added = [];
    for (const app of apps) {
      const cur = this.apps.get(app.id);
      if (!cur) {
        await this.refreshApp(app);
        added.push(app.id);
        continue;
      }
      const reconnect = cur.cfg.url !== app.url
        || (cur.cfg.auth?.token || '') !== (app.auth?.token || '')
        || (cur.cfg.timeout || 0) !== (app.timeout || 0);
      cur.cfg = app;                      // allow_risk / aliases / tools 就地更新
      if (reconnect) await this.refreshApp(app);
    }
    this.config.apps = apps;
    this._build();
    return added;
  }

  removeApp(id) {
    this.apps.delete(id);
    this._build();
  }

  // 从 apps 的 rawTools 重建扁平索引
  _build() {
    const tools = [];
    for (const [appId, entry] of this.apps) {
      const app = entry.cfg;
      const overrides = app.tools?.risk_overrides || {};
      const include = app.tools?.include || [];
      const exclude = app.tools?.exclude || [];

      for (const t of entry.rawTools || []) {
        if (exclude.includes(t.name)) continue;
        if (include.length && !include.includes(t.name)) continue;

        const manual = [
          ...(app.tools?.aliases?.[t.name] || []),
          ...(t.aliases || []),
        ];
        const derived = deriveTitleAliases(t.title || '');
        const nameTokens = tokenize(t.name.replace(/_/g, ' '));
        const titleTokens = tokenize(t.title || '');
        const descTokens = tokenize(t.description || '');

        // 加权合并：同一 token 取最高权重，title/name 比描述更"值钱"
        const weights = new Map();
        const add = (set, w) => { for (const k of set) weights.set(k, Math.max(weights.get(k) || 0, w)); };
        add(descTokens, 1.0);
        add(titleTokens, 1.6);
        add(nameTokens, 1.4);
        for (const a of manual) add(tokenize(a), 2.2);
        for (const a of derived) add(tokenize(a), 1.8);

        tools.push({
          key: `${appId}.${t.name}`,
          appId,
          appLabel: app.label || appId,
          name: t.name,
          title: t.title || '',
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          annotations: t.annotations || {},
          risk: deriveRisk(t, overrides),
          aliases: manual,          // 人工写在配置里的
          derived: derived,         // 从 title 自动派生的动作词
          tokens: weights,
          titleTokens,
        });
      }
    }

    // 文档频率：用于 idf
    const df = new Map();
    for (const t of tools) {
      for (const k of t.tokens.keys()) df.set(k, (df.get(k) || 0) + 1);
    }
    this._df = df;
    this.tools = tools.sort((a, b) => a.key.localeCompare(b.key));
    this._builtAt = Date.now();
    return this.tools;
  }

  _idf(token) {
    const n = Math.max(1, this.tools.length);
    const d = this._df.get(token) || 0;
    return Math.log((n + 1) / (d + 0.5));
  }

  // 应用前缀：「邮箱 未读」「路由 状态」→ 剥离前缀后只在该应用内搜
  _stripAppPrefix(text) {
    const raw = String(text || '').trim();
    for (const [appId, entry] of this.apps) {
      const names = [entry.cfg.label, appId, ...(entry.cfg.aliases || [])].filter(Boolean);
      for (const n of names) {
        if (!n) continue;
        const re = new RegExp(`^\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,，、:：\\s]?\\s*`, 'i');
        if (re.test(raw)) return { text: raw.replace(re, ''), appId };
      }
    }
    return { text: raw, appId: null };
  }

  match(text) {
    const { text: q, appId } = this._stripAppPrefix(text);
    const qLower = q.toLowerCase().trim();
    const qTokens = tokenize(q);
    const pool = appId ? this.tools.filter((t) => t.appId === appId) : this.tools;

    const scored = [];
    for (const tool of pool) {
      // ① 手写别名命中：最可信，直接 1.0（用户自己写下的说法，几乎不会错）
      let hard = 0;
      for (const a of tool.aliases) {
        const al = String(a).toLowerCase();
        if (al.length >= 2 && qLower.includes(al)) hard = 1;
      }
      // ①' 从 title 派生的动作词（「删」「删除」「搜」「搜索」）：次之，0.82
      if (hard < 0.82) {
        for (const a of tool.derived) {
          const al = String(a).toLowerCase();
          if (al.length >= 1 && qLower.includes(al)) { hard = Math.max(hard, 0.82); }
        }
      }
      // ② 名称整体命中
      const bare = tool.name.replace(/_/g, ' ');
      const nameHit = qLower.includes(tool.name.toLowerCase()) || qLower.includes(bare.toLowerCase());

      // ③ idf 加权覆盖度
      //    · df=0 的 token 是用户语气词，不计入分母（否则会稀释关键词）
      //    · 单字在 title 里命中打 8 折，只在 description 里命中打 4 折
      //      ——「删」「搜」「发」这些动作词在 title 里，必须能拿高分
      let total = 0;
      let hit = 0;
      for (const tok of qTokens) {
        const df = this._df.get(tok) || 0;
        if (df === 0) continue;
        const idf = this._idf(tok);
        total += idf;
        const w = tool.tokens.get(tok);
        if (w) {
          const singleMul = tok.length === 1 ? (tool.titleTokens.has(tok) ? 0.8 : 0.4) : 1;
          hit += idf * Math.min(1, w / 1.6) * singleMul;
        }
      }
      // 覆盖率上限 0.92：保证手写别名（1.0）永远排在纯文本匹配之前
      let cov = total > 0 ? (hit / total) * 0.92 : 0;
      if (nameHit) cov = Math.max(cov, 0.85);
      const score = Math.min(1, Math.max(hard, cov));
      if (score >= 0.15) scored.push({ tool, score });
    }

    // 分数接近时让只读排前面：同样能"列出文件夹"和"新建文件夹"，
    // 用户更想看的通常是列出来那一个，而且只读操作错了也没有后果。
    scored.sort((a, b) => {
      const d = b.score - a.score;
      if (Math.abs(d) > 0.05) return d;
      return (RISK_ORDER[a.tool.risk] - RISK_ORDER[b.tool.risk])
        || a.tool.key.localeCompare(b.tool.key);
    });
    const best = scored[0] || null;
    const second = scored[1] || null;
    const th = this.config.routing.local_threshold;
    const ask = this.config.routing.ask_threshold;

    return {
      query: q,
      appId,
      best,
      second,
      candidates: scored.slice(0, 6),
      confident: !!best && best.score >= th,
      ambiguous: !!best && best.score >= ask && second && best.score - second.score < 0.12,
      understood: !!best && best.score >= ask,
    };
  }

  // 按 "app.tool" 或 "tool" 精确定位
  find(id) {
    if (!id) return null;
    const exact = this.tools.find((t) => t.key === id);
    if (exact) return exact;
    const byName = this.tools.filter((t) => t.name === id);
    if (byName.length === 1) return byName[0];
    if (this.config.gateway.default_app) {
      const inApp = byName.find((t) => t.appId === this.config.gateway.default_app);
      if (inApp) return inApp;
    }
    return byName[0] || null;
  }

  // 供 LLM 用的精简工具清单（省 token：不带 tokens/权重这些内部字段）
  llmTools(appFilter = null) {
    return this.tools
      .filter((t) => !appFilter || t.appId === appFilter)
      .map((t) => ({
        name: t.key,                       // 用 app.tool 保证跨应用唯一
        description: [t.title, t.description].filter(Boolean).join('：').slice(0, 300),
        inputSchema: t.inputSchema,
      }));
  }

  stats() {
    const apps = [...this.apps.values()].map((e) => ({
      id: e.cfg.id,
      label: e.cfg.label || e.cfg.id,
      status: e.status,
      error: e.error,
      toolCount: e.toolCount,
      protocolVersion: e.protocolVersion,
      serverInfo: e.serverInfo,
    }));
    return { apps, toolCount: this.tools.length, builtAt: this._builtAt };
  }
}
