// 应用与设置的管理：把「手写配置」和「界面改的配置」分开存。
//
// 为什么必须分两层：
//   config.json 是人手写的，里面有 ${ENV} 占位符，值在容器环境变量里。
//   如果界面改完直接回写这个文件，load 时替换好的明文 token 就会被写进去——
//   等于把密钥从环境变量搬到了磁盘上的明文文件里，比原来更糟。
//
// 所以：
//   · config.json        只读，界面永不修改（用户自己的东西，要改让人改）
//   · data/overrides.json 界面加的/改的应用与设置，不含任何密钥
//   · data/secrets.json   真正的 token / api_key，0600，API 永不回传原值
//
// 合并规则：同 id 时 overrides 覆盖 config.json（界面优先），其余保持。

import path from 'node:path';
import { readJson, writeJson } from './store.js';
import { McpClient, McpError } from './mcp.js';
import { errText } from './log.js';

const DEFAULT_SETTINGS = {
  default_app: null,
  confirm_risk: ['high'],
  confirm_ttl: 60,
  call_timeout: 20,
  async_after: 10,
  log_keep: 200,          // 调用日志保留条数（50~200）
  local_threshold: 0.5,
  ask_threshold: 0.25,
  llm_when: 'miss',
  llm_enabled: false,
  llm_default: '',
};

function pickSettings(src = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export class AppStore {
  constructor({ dataDir, baseConfig, log }) {
    this.dataDir = dataDir;
    this.baseConfig = baseConfig;          // loadConfig() 的产物（含 ${ENV} 替换后的值）
    this.log = log;
    this.overridesFile = path.join(dataDir, 'overrides.json');
    this.secretsFile = path.join(dataDir, 'secrets.json');
    this.overrides = readJson(this.overridesFile, { apps: [], settings: {}, providers: {} });
    this.secrets = readJson(this.secretsFile, { tokens: {}, apiKeys: {} });
    this.overrides.apps ||= [];
    this.overrides.settings ||= {};
    this.overrides.providers ||= {};
    this.secrets.tokens ||= {};
    this.secrets.apiKeys ||= {};
  }

  _saveOverrides() {
    writeJson(this.overridesFile, this.overrides, { mode: 0o600 });
  }

  _saveSecrets() {
    writeJson(this.secretsFile, this.secrets, { mode: 0o600 });
  }

  // ---- 应用 ----------------------------------------------------------

  // 给 Registry 用：合并后的完整配置，**含真实 token**
  resolvedApps() {
    const byId = new Map();
    for (const a of this.baseConfig.apps || []) {
      byId.set(a.id, { ...a, _source: 'config' });
    }
    for (const a of this.overrides.apps) {
      const base = byId.get(a.id) || {};
      const merged = { ...base, ...a, _source: 'ui' };
      // 界面没填过 token 时沿用 config.json 里的那份，否则「只改个名字」
      // 会把写死在配置文件里的凭据悄悄抹掉，表现是对端突然 401。
      merged.auth = { type: 'bearer', token: this.secrets.tokens[a.id] || base.auth?.token || '' };
      byId.set(a.id, merged);
    }
    // config.json 里的应用也可能带 token（手写或用环境变量注入），保留原样
    return [...byId.values()];
  }

  // 给 API 用：token 脱敏成布尔值，界面永远拿不到原值
  list() {
    return this.resolvedApps().map((a) => {
      const entry = {
        id: a.id,
        label: a.label || a.id,
        aliases: a.aliases || [],
        url: a.url,
        allow_risk: a.allow_risk || ['read'],
        tools: a.tools || {},
        timeout: a.timeout || null,
        source: a._source,
        hasToken: !!a.auth?.token,
      };
      return entry;
    });
  }

  upsert(app, token) {
    const id = String(app.id || '').trim();
    if (!id) throw new Error('缺少 id');
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new Error('id 只能用字母、数字、下划线、短横线，最长 32');

    const clean = {
      id,
      label: String(app.label || id).trim(),
      aliases: (app.aliases || []).map((s) => String(s).trim()).filter(Boolean),
      transport: 'mcp-http',
      url: String(app.url || '').trim(),
      allow_risk: (app.allow_risk || ['read']).filter((r) => ['read', 'write', 'high'].includes(r)),
      tools: app.tools || {},
      timeout: app.timeout ? Number(app.timeout) : undefined,
    };
    if (!clean.url) throw new Error('缺少地址');
    if (!/^https?:\/\//i.test(clean.url)) throw new Error('地址必须以 http:// 或 https:// 开头');

    const i = this.overrides.apps.findIndex((x) => x.id === id);
    if (i >= 0) this.overrides.apps[i] = { ...this.overrides.apps[i], ...clean };
    else this.overrides.apps.push(clean);

    // token 为空表示"不修改"，这样界面可以只改地址不动凭据
    if (typeof token === 'string' && token.length) {
      this.secrets.tokens[id] = token;
      this._saveSecrets();
    }
    this._saveOverrides();
    return clean;
  }

  remove(id) {
    const before = this.overrides.apps.length;
    this.overrides.apps = this.overrides.apps.filter((a) => a.id !== id);
    const hadSecret = !!this.secrets.tokens[id];
    delete this.secrets.tokens[id];
    if (hadSecret) this._saveSecrets();
    this._saveOverrides();
    // 手写配置里的应用不能从界面删（只挡一下，提示用户去改文件）
    if (this.overrides.apps.length === before && (this.baseConfig.apps || []).some((a) => a.id === id)) {
      throw new Error('这个应用写在 config.json 里，界面删不掉，请编辑文件后重启');
    }
    return true;
  }

  // 用一份草稿试连，不入库。界面「测试连接」就是它。
  async testConnection(draft, tokenOverride) {
    const id = draft.id || 'probe';
    // 界面上没填时，沿用这个应用已有的那份（可能来自 secrets.json，
    // 也可能写在 config.json 里）。否则「只改地址点测试」会拿空令牌去连，
    // 报鉴权失败，看上去像地址填错了。
    const existing = this.resolvedApps().find((a) => a.id === id)?.auth?.token || '';
    const token = tokenOverride !== undefined && tokenOverride !== ''
      ? tokenOverride
      : (this.secrets.tokens[id] || existing || '');

    const c = new McpClient({
      url: draft.url,
      token,
      timeout: Math.min(20000, (Number(draft.timeout) || 15) * 1000),
      headers: draft.headers || {},
      id,
    });
    const started = Date.now();
    try {
      const init = await c.initialize();
      const { tools } = await c.listTools();
      return {
        ok: true,
        ms: Date.now() - started,
        protocolVersion: init.protocolVersion,
        serverInfo: init.serverInfo,
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title || '',
          description: String(t.description || '').slice(0, 200),
          risk: t.annotations?.destructiveHint ? 'high' : (t.annotations?.readOnlyHint ? 'read' : 'write'),
          required: t.inputSchema?.required || [],
        })),
      };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - started,
        kind: e instanceof McpError ? e.kind : 'unknown',
        message: e instanceof McpError ? e.message : errText(e),
        detail: e?.detail || null,
        hint: hintFor(e),
      };
    }
  }

  // ---- 设置 ----------------------------------------------------------

  settings() {
    const fromFile = pickSettings(this.baseConfig.gateway || {});
    const routing = pickSettings(this.baseConfig.routing || {});
    const llm = {
      llm_enabled: this.baseConfig.llm?.enabled === true,
      llm_default: this.baseConfig.llm?.default || '',
      llm_when: this.baseConfig.routing?.llm_when || 'miss',
    };
    return {
      ...DEFAULT_SETTINGS,
      ...fromFile,
      ...routing,
      ...llm,
      ...this.overrides.settings,
    };
  }

  saveSettings(patch = {}) {
    const s = { ...this.overrides.settings };
    const num = (v, lo, hi, fb) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fb;
      return Math.min(hi, Math.max(lo, Math.round(n)));
    };

    if (patch.log_keep !== undefined) s.log_keep = num(patch.log_keep, 50, 200, 200);
    if (patch.confirm_ttl !== undefined) s.confirm_ttl = num(patch.confirm_ttl, 10, 600, 60);
    if (patch.call_timeout !== undefined) s.call_timeout = num(patch.call_timeout, 5, 300, 20);
    if (patch.async_after !== undefined) s.async_after = num(patch.async_after, 1, 120, 10);
    if (patch.local_threshold !== undefined) s.local_threshold = Math.min(1, Math.max(0.1, Number(patch.local_threshold) || 0.5));
    if (patch.default_app !== undefined) s.default_app = patch.default_app || null;
    if (patch.llm_when !== undefined && ['never', 'miss', 'ambiguous', 'always'].includes(patch.llm_when)) {
      s.llm_when = patch.llm_when;
    }
    if (patch.llm_enabled !== undefined) s.llm_enabled = patch.llm_enabled === true;
    if (patch.llm_default !== undefined) s.llm_default = String(patch.llm_default || '');
    if (Array.isArray(patch.confirm_risk)) {
      s.confirm_risk = patch.confirm_risk.filter((r) => ['read', 'write', 'high'].includes(r));
    }

    this.overrides.settings = s;
    this._saveOverrides();
    return this.settings();
  }

  // ---- AI 服务商 -----------------------------------------------------
  // api_key 存 secrets.json，界面只看到 hasKey

  providers() {
    const base = this.baseConfig.llm?.providers || {};
    const out = {};
    for (const [id, p] of Object.entries(base)) {
      out[id] = {
        id,
        label: p.label || id,
        type: p.type || 'openai',
        base_url: p.base_url || '',
        model: p.model || '',
        hasKey: !!p.api_key || !!this.secrets.apiKeys[id],
        source: 'config',
      };
    }
    for (const [id, p] of Object.entries(this.overrides.providers)) {
      out[id] = {
        ...p,
        id,
        hasKey: !!this.secrets.apiKeys[id],
        source: 'ui',
      };
    }
    return out;
  }

  // 给 llm.js 用：合并后的 provider，含真实 key
  // 顺序是「界面填的 > config.json 里的」，否则在界面上换了 key 却毫无反应，
  // 只会表现为 AI 一直报鉴权失败，很难往"配置没生效"上想。
  resolvedProviders() {
    const base = this.baseConfig.llm?.providers || {};
    const out = {};
    for (const [id, p] of Object.entries(base)) {
      out[id] = { ...p, api_key: this.secrets.apiKeys[id] || p.api_key || '' };
    }
    for (const [id, p] of Object.entries(this.overrides.providers)) {
      // 界面只改了模型名、没重填 key 时，沿用 config.json 里那份
      out[id] = { ...p, api_key: this.secrets.apiKeys[id] || base[id]?.api_key || '' };
    }
    return out;
  }

  upsertProvider(p, apiKey) {
    const id = String(p.id || '').trim();
    if (!id) throw new Error('缺少 id');
    if (!/^[a-z0-9_-]{1,32}$/i.test(id)) throw new Error('id 只能用字母、数字、下划线、短横线');
    const clean = {
      label: String(p.label || id),
      type: p.type === 'anthropic' ? 'anthropic' : 'openai',
      base_url: String(p.base_url || '').replace(/\/+$/, ''),
      model: String(p.model || ''),
      timeout: p.timeout ? Number(p.timeout) : undefined,
      max_tokens: p.max_tokens ? Number(p.max_tokens) : undefined,
    };
    if (!clean.base_url) throw new Error('缺少 base_url');
    if (!clean.model) throw new Error('缺少 model');

    this.overrides.providers[id] = clean;
    if (typeof apiKey === 'string' && apiKey.length) {
      this.secrets.apiKeys[id] = apiKey;
      this._saveSecrets();
    }
    this._saveOverrides();
    return { id, ...clean, hasKey: !!this.secrets.apiKeys[id] };
  }

  removeProvider(id) {
    delete this.overrides.providers[id];
    const had = !!this.secrets.apiKeys[id];
    delete this.secrets.apiKeys[id];
    if (had) this._saveSecrets();
    this._saveOverrides();
    if (this.overrides.settings.llm_default === id) {
      this.overrides.settings.llm_default = '';
      this._saveOverrides();
    }
    return true;
  }
}

// 把 MCP 层的错误分类翻成"下一步该干嘛"。用户看到的必须是动作，不是错误码。
function hintFor(e) {
  const kind = e instanceof McpError ? e.kind : '';
  switch (kind) {
    case 'dns': return '容器名解析不了。确认它和网关在同一个 docker network，地址里别写 localhost。';
    case 'refused': return '端口没开或服务没起。检查端口是不是容器内端口（不是映射到宿主机的那个）。';
    case 'auth': return '令牌无效或过期。去应用的「Agent 接入」里重新生成一个。';
    case 'path': return '路径不对。多数 MCP 端点是 /mcp，少数是 /sse，先用 curl -i 看一眼。';
    case 'accept': return '对端要求 Accept 头同时带 application/json 和 text/event-stream——网关已处理，出现这条说明对端实现比较特殊。';
    case 'timeout': return '连不上或者太慢。确认目标可达：从网关容器里执行 curl <地址>。';
    case 'protocol': return '对端不是标准 MCP，或者握手版本不兼容。';
    default: return '换一个已知能用的 MCP server 试一次，能通就说明是这边的问题。';
  }
}
