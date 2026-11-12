// CLI 连接器：把一个命令行工具当成「一个应用」接进来。
//
// 为什么需要这一层：WorkBuddy 的连接器里有一大批（manifest 是 cli.json 的那类）
// 根本不提供 MCP 端点，形态是「装一个 CLI → 登录 → 把命令行交给模型」。
// 网关原来只会连网址，这类一个都接不了，这里补的就是那一跳：
//
//   微信 → 模型选工具 → runTool → CliClient.callTool → spawn 命令 → 解析 JSON
//                                      ↑ 只有这一跳是新的，渲染/风险/确认全复用
//
// 刻意不做的事：
//   · 不判断这是哪个厂商。谁的命令行都走同一套 spec。
//   · 不猜参数含义。工具表由 cli-tools.js 从 --help 抽，或用户在配置里手写。
//   · 不直接拼 shell 字符串。一律 argv 数组，避免空格/引号注入。
//
// 安全边界在 exec 层（allow_risk + confirm），这里只管"照着 spec 跑一条命令"。

import { spawn } from 'node:child_process';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_OUT = 256 * 1024;

export class CliError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'CliError';
    this.kind = kind;   // spawn | timeout | exit | json | config
    this.detail = detail || null;
  }
}

function strip(s) {
  return String(s || '').replace(ANSI, '').replace(/\r\n/g, '\n');
}

// 把「一堆长得像人话的报错」翻成「下一步该干嘛」。
// 命令行工具的错误文本五花八门，但真正的处置只有几种，认到就能给对提示。
const ERR_RULES = [
  [/permission.?denied|not granted|unauthor|forbidden|403/i,
    '这个应用的凭据没有这项权限。去它那边把对应权限打开（或换一个权限更大的令牌）再试。'],
  // cobra 的「required flag(s) "path" not set」这类：参数没给或给错名字。
  // 原文对用户是噪声（flag 是什么？），但它是模型没补参数的直接证据。
  [/required flag|flag needs an argument|unknown (shorthand )?flag|invalid argument .* for /i,
    '这次调用缺参数（或参数名写错了）。把选项补齐再调一次。'],
  [/401|token (is )?(invalid|expired)|authentication failed/i,
    '令牌无效或过期了。去应用里重新登录/重新生成一个，再更新到网关。'],
  [/connection refused|no route to host|dial tcp.*(refused|timeout)|i\/o timeout/i,
    '连不上目标。确认地址和端口，以及网关容器能不能访问到它（容器之间用服务名，别写 localhost）。'],
  [/x509|certificate|tls handshake|self.signed/i,
    '证书没通过校验。如果是自己的设备用的自签证书，在应用配置里打开「允许自签证书」。'],
  [/not found|no such file|does not exist|unknown command/i,
    '命令或路径不存在。检查可执行文件路径和子命令名是不是对的。'],
  [/timed? ?out|deadline exceeded/i, '对端响应太慢，超时了。稍后再试，或把这个应用的超时调大。'],
  [/EACCES|permission denied when running/i, '这个程序没有执行权限，检查文件权限。'],
];

export function humanCliError(text) {
  const s = String(text || '').trim();
  if (!s) return '命令没有返回任何内容，通常是参数不对。';
  for (const [re, msg] of ERR_RULES) {
    if (re.test(s)) return msg;
  }
  // 认不出来就截一段原始输出：比"未知错误"有用，也比整段刷屏好
  const line = s.split('\n').map((x) => x.trim()).filter(Boolean)[0] || s;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

// 参数 → argv。spec 的样子：
//   { command:['docker','ps'], params:[{name:'all',flag:'--all',type:'boolean'}] }
// 布尔为 true 才加 flag；其余 --flag value；pos 是位置参数，按 pos 排序接在命令后面。
export function buildArgv(spec, baseArgs, args = {}) {
  const out = [...(spec.command || [])];
  const positional = [];
  for (const p of spec.params || []) {
    const raw = args[p.name];
    if (raw === undefined || raw === null || raw === '') continue;
    if (p.type === 'boolean') {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') out.push(p.flag || `--${p.name}`);
      continue;
    }
    if (Number.isInteger(p.pos)) {
      positional.push([p.pos, String(raw)]);
      continue;
    }
    const flag = p.flag || `--${p.name}`;
    if (Array.isArray(raw)) {
      for (const v of raw) out.push(flag, String(v));
    } else if (p.equals) {
      out.push(`${flag}=${raw}`);
    } else {
      out.push(flag, String(raw));
    }
  }
  positional.sort((a, b) => a[0] - b[0]);
  for (const [, v] of positional) out.push(v);
  // --format json 这类全局参数放最后：cobra/pflag 允许持久参数写在子命令后面，
  // 放前面反而可能被当成子命令的一部分（`bin --format json file ls` 在个别工具上会失败）。
  return [...out, ...(baseArgs || [])];
}

// 参数 spec → 模型能用的 JSON Schema
export function paramsToSchema(spec) {
  const props = {};
  const required = [];
  for (const p of spec.params || []) {
    const t = p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string';
    props[p.name] = {
      type: t,
      ...(p.desc ? { description: String(p.desc).slice(0, 160) } : {}),
      ...(t === 'boolean' ? {} : {}),
    };
    if (Array.isArray(p.enum) && p.enum.length) props[p.name].enum = p.enum;
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
}

// 从任意层的 JSON 里挖「最像列表」的那个数组。
// MCP 应用返回的通常是 {messages:[...]} 一层就够，命令行工具的 JSON 常常是
// {success:true, data:{data:{file_list:{files:[...]}}}} 这种四层嵌套——
// 不挖出来，渲染层会把它当纯文本，微信里就是一大段 JSON。
const LIST_KEYS = ['files', 'list', 'items', 'results', 'result', 'rows', 'data', 'volumes', 'containers', 'apps', 'tasks', 'disks', 'users', 'processes', 'services'];
function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepList(node, depth = 0) {
  if (depth > 4 || !node) return null;
  if (Array.isArray(node)) {
    return node.length && node.every(isPlain) ? node : null;
  }
  if (!isPlain(node)) return null;
  // 先按"大概率是列表"的键名找
  for (const k of LIST_KEYS) {
    if (Array.isArray(node[k]) && node[k].length && node[k].every(isPlain)) return node[k];
  }
  for (const v of Object.values(node)) {
    const hit = deepList(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// 列表项压成一行给渲染层用（它认 name/title/label 这些键）
function shapeForRender(parsed) {
  const list = deepList(parsed);
  if (list?.length) return { items: list };
  return parsed;
}

export class CliClient {
  /**
   * @param {object} o
   * @param {string} o.id      应用 id（日志用）
   * @param {string} o.bin     可执行文件绝对路径或 PATH 里的名字
   * @param {string[]} [o.prefix] 紧跟在 bin 后面的固定部分。给"解释器 + 脚本"用：
   *                            bin=node, prefix=['/data/x.js'] → node /data/x.js <子命令>
   * @param {string[]} [o.args]  每次都带的固定参数（放在子命令后面），例如 ['--format','json']
   * @param {object} [o.env]   只注入这个应用的子进程，不影响网关自身
   * @param {string} [o.cwd]
   * @param {string[]} [o.probe] 探活命令，默认 ['--version']
   * @param {Array} [o.specs]  工具表（cli-tools.js 生成，或用户手写）
   * @param {boolean} [o.generic] 允许一个「跑任意子命令」的兜底工具
   * @param {number} [o.timeout]
   */
  constructor({ id, bin, prefix = [], args = [], env = {}, cwd = null, probe = null, specs = [], generic = false, timeout = 20000 }) {
    this.id = id;
    this.bin = bin;
    this.prefix = Array.isArray(prefix) ? prefix : [];
    this.args = args;
    this.env = env || {};
    this.cwd = cwd || null;
    this.probe = Array.isArray(probe) && probe.length ? probe : ['--version'];
    this.specs = Array.isArray(specs) ? specs : [];
    this.generic = generic === true;
    this.timeout = timeout;
  }

  _spawn(argv, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.bin, [...this.prefix, ...argv], {
          cwd: this.cwd || undefined,
          env: { ...process.env, ...this.env },
          windowsHide: true,
        });
      } catch (e) {
        reject(new CliError('spawn', `启动不了 ${this.bin}：${e?.message || e}`));
        return;
      }
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      }, Math.max(1000, timeoutMs));

      child.stdout?.on('data', (d) => { if (out.length < MAX_OUT) out += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { if (err.length < MAX_OUT) err += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new CliError('spawn', e?.code === 'ENOENT'
          ? `找不到可执行文件：${this.bin}`
          : `启动失败：${e?.message || e}`, { code: e?.code }));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, out: strip(out), err: strip(err), killed });
      });
    });
  }

  async initialize() {
    const started = Date.now();
    let r;
    try {
      r = await this._spawn(this.probe, Math.min(8000, this.timeout));
    } catch (e) {
      throw e instanceof CliError ? e : new CliError('spawn', String(e?.message || e));
    }
    if (r.killed) throw new CliError('timeout', '探活超时，命令没有响应');
    if (r.code !== 0) {
      // 有些工具的 --version 返回非 0 但打印了版本；有输出就当它活着
      if (!(r.out || r.err).trim()) {
        throw new CliError('exit', `这个命令跑不起来（退出码 ${r.code}）：${humanCliError(r.err || r.out)}`, { code: r.code });
      }
    }
    const raw = `${r.out}\n${r.err}`.trim();
    const ver = (raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/) || [null])[0];
    return {
      protocolVersion: 'cli/1',
      serverInfo: { name: this.bin.split(/[\\/]/).pop(), version: ver || '', raw: raw.slice(0, 200) },
      ms: Date.now() - started,
    };
  }

  async listTools() {
    const tools = this.specs.map((s) => ({
      name: s.name,
      title: s.title || '',
      description: s.description || s.title || s.name,
      inputSchema: s.inputSchema || paramsToSchema(s),
      annotations: {},
      risk: s.risk || 'read',
    }));
    if (this.generic) {
      tools.push({
        name: 'run',
        title: '执行任意子命令',
        description: '直接执行这个命令行工具的子命令。参数按空格切成数组传入，例如 ["docker","ps","--format","json"]。只在没有现成工具能用时才用它。',
        inputSchema: {
          type: 'object',
          properties: { argv: { type: 'array', items: { type: 'string' }, description: '子命令与参数' } },
          required: ['argv'],
        },
        annotations: {},
        risk: 'high',
      });
    }
    return { tools, ms: 0 };
  }

  async callTool(name, args = {}) {
    const started = Date.now();
    let argv;

    if (name === 'run' && this.generic) {
      const extra = Array.isArray(args.argv) ? args.argv.map(String) : [];
      if (!extra.length) return { isError: true, text: '没有给要执行的子命令。', ms: 0 };
      argv = [...extra, ...this.args];
    } else {
      const spec = this.specs.find((s) => s.name === name);
      if (!spec) return { isError: true, text: `这个应用里没有「${name}」这个命令。`, ms: 0 };
      argv = buildArgv(spec, this.args, args);
    }

    let r;
    try {
      r = await this._spawn(argv, this.timeout);
    } catch (e) {
      return { isError: true, text: humanCliError(e?.message || e), ms: Date.now() - started, kind: e?.kind };
    }

    if (r.killed) {
      return {
        isError: true,
        text: `等太久没返回（超过 ${Math.round(this.timeout / 1000)} 秒），已经停掉了。`,
        ms: Date.now() - started,
        timeout: true,
      };
    }

    const raw = (r.out || r.err || '').trim();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch {
        // 有些工具会在 JSON 前后打日志，切出最外层的对象再试一次
        const a = raw.indexOf('{');
        const b = raw.lastIndexOf('}');
        if (a >= 0 && b > a) {
          try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch { /* 真不是 JSON */ }
        }
      }
    }

    // 应用自己报的失败（很多 CLI 用退出码 0 + success:false 表示业务失败）
    if (isPlain(parsed) && parsed.success === false) {
      const msg = parsed.error?.message || parsed.message || parsed.error || '应用说这次没成功';
      return { isError: true, text: humanCliError(String(msg)), ms: Date.now() - started, raw: msg };
    }

    if (r.code !== 0) {
      const detail = String(parsed?.error?.message || parsed?.message || r.err || r.out || '').trim();
      return { isError: true, text: humanCliError(detail), ms: Date.now() - started, code: r.code, raw: detail.slice(0, 400) };
    }

    if (!raw) {
      return { isError: false, text: '', data: null, ms: Date.now() - started };
    }
    if (!parsed) {
      return { isError: false, text: raw, data: null, ms: Date.now() - started };
    }
    return {
      isError: false,
      text: JSON.stringify(parsed, null, 1).slice(0, 8000),
      data: shapeForRender(parsed),
      ms: Date.now() - started,
    };
  }
}
