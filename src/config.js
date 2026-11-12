// 配置加载：纯标准 JSON（零依赖，不引 JSON5），支持 ${ENV_VAR} 占位。
// 设计原则：配置里永不出现明文密钥——只写 ${VAR}，值放容器环境变量。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  gateway: {
    default_app: null,        // 不带应用前缀时默认给谁（null = 让用户选）
    confirm_risk: ['high'],   // 这些风险等级必须回「确认」
    confirm_ttl: 60,          // 确认窗口（秒）
    call_timeout: 20,         // 单次工具调用超时（秒）
    async_after: 10,          // 超过这个秒数就先回执、转后台
  },
  routing: {
    // 只保留「检索」这一件事：本地不再决定执行什么，只决定把哪些工具递给模型。
    // 阈值一个都不留——判断一个工具该不该被执行是模型的事，本地只负责排序。
    search_limit: 8,          // 每次检索返回几个候选
  },
  // Agent 闭环：模型唯一的工作方式。没有第二条路，也不再有开关。
  agent: {
    max_rounds: 6,       // 最多几轮工具调用（其中一轮可能花在检索工具上）
    max_ms: 45000,       // 整轮时间预算（毫秒），超了就把已查到的先发出去
  },
  llm: {
    enabled: false,
    default: '',              // 默认 provider 的 id
    timeout: 15,              // 秒
    max_tokens: 512,
    providers: {},
  },
  apps: [],
};

function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlain(base)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// ${VAR} 递归替换。缺失的环境变量替换为空串，由 validate 报出来。
function subst(v, missing) {
  if (typeof v === 'string') {
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => {
      const val = process.env[k];
      if (val === undefined) { missing.add(k); return ''; }
      return val;
    });
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, missing));
  if (isPlain(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = subst(x, missing);
    return out;
  }
  return v;
}

export function validate(cfg) {
  const errors = [];
  const warns = [];

  const ids = new Set();
  for (const [i, app] of (cfg.apps || []).entries()) {
    const where = `apps[${i}]`;
    if (!app.id) { errors.push(`${where} 缺少 id`); continue; }
    if (ids.has(app.id)) errors.push(`${where} id 重复：${app.id}`);
    ids.add(app.id);
    if (!app.label) warns.push(`${where}(${app.id}) 没有 label，界面上会显示成 id`);
    // 两种接入方式：
    //   mcp-http —— 连一个网址（对方自己跑着 MCP server）
    //   cli      —— 在容器里跑一条命令（对方只提供命令行工具）
    const transport = app.transport || 'mcp-http';
    if (!['mcp-http', 'cli'].includes(transport)) {
      errors.push(`${where}(${app.id}) transport 只支持 mcp-http / cli，收到：${app.transport}`);
    } else if (transport === 'cli') {
      if (!app.cli?.bin) errors.push(`${where}(${app.id}) 是 cli 类型，缺少 cli.bin（可执行文件路径）`);
      if (app.cli?.tools && !Array.isArray(app.cli.tools)) {
        errors.push(`${where}(${app.id}) cli.tools 必须是数组`);
      }
      if (app.cli?.prefix && !Array.isArray(app.cli.prefix)) {
        errors.push(`${where}(${app.id}) cli.prefix 必须是数组（解释器 + 脚本场景用）`);
      }
      if (!Array.isArray(app.cli?.tools) || !app.cli.tools.length) {
        warns.push(`${where}(${app.id}) 还没有工具表，导入后需要先探测一次才能用`);
      }
    } else if (!app.url) {
      errors.push(`${where}(${app.id}) 缺少 url`);
    }
    if (app.url && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(app.url) && process.env.GATEWAY_IN_CONTAINER === '1') {
      warns.push(`${where}(${app.id}) 用的是 localhost —— 容器里那是它自己，连不到别的服务；改用服务名或内网 IP`);
    }
    if (!Array.isArray(app.allow_risk)) {
      app.allow_risk = ['read'];
      warns.push(`${where}(${app.id}) 未声明 allow_risk，已默认只放行 read`);
    }
  }

  const provs = cfg.llm?.providers || {};
  if (cfg.llm?.enabled) {
    if (!cfg.llm.default) errors.push('llm.enabled=true 但没有指定 llm.default');
    else if (!provs[cfg.llm.default]) errors.push(`llm.default 指向不存在的 provider：${cfg.llm.default}`);
    for (const [id, p] of Object.entries(provs)) {
      if (!p.base_url) errors.push(`llm.providers.${id} 缺少 base_url`);
      if (!p.model) errors.push(`llm.providers.${id} 缺少 model`);
      if (p.type && !['openai', 'anthropic'].includes(p.type)) {
        errors.push(`llm.providers.${id} type 只支持 openai / anthropic，收到：${p.type}`);
      }
      if (!p.api_key && p.type !== 'openai') warns.push(`llm.providers.${id} 没有 api_key`);
    }
  }

  return { errors, warns };
}

export function loadConfig(file) {
  const target = path.resolve(file || process.env.GATEWAY_CONFIG || 'config.json');
  if (!fs.existsSync(target)) {
    throw new Error(`找不到配置文件 ${target}。先复制 config.example.json 为 config.json 再改。`);
  }
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  const missing = new Set();
  const withEnv = subst(raw, missing);
  const cfg = deepMerge(DEFAULTS, withEnv);

  const { errors, warns } = validate(cfg);
  // 缺环境变量只警告，不阻止启动——有些 app 是免鉴权的
  for (const k of missing) warns.push(`环境变量 ${k} 未设置，已按空串处理`);

  return { config: cfg, errors, warns, file: target };
}

// 取某个 provider 的可用配置；未指定则用默认 provider
export function resolveProvider(cfg, id) {
  const llm = cfg.llm || {};
  const pid = id || llm.default;
  if (!pid) throw new Error('没有配置默认 AI 服务商');
  const p = llm.providers?.[pid];
  if (!p) throw new Error(`AI 服务商不存在：${pid}`);
  return {
    id: pid,
    type: p.type || 'openai',
    base_url: String(p.base_url || '').replace(/\/+$/, ''),
    model: p.model,
    api_key: p.api_key || '',
    headers: p.headers || {},
    label: p.label || pid,
  };
}
