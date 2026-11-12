// 从 `--help` 里抽工具表。
//
// 为什么要有这一层：cli.json 只告诉你怎么装、怎么登录，**不告诉你有哪几个能力**
// （WorkBuddy 的做法是装完把命令行丢给模型，模型自己敲 --help）。网关要在微信里
// 逐条调用，就必须先知道"有哪些子命令、各要什么参数"。
//
// 解析对象是 cobra/pflag 的输出（Go 写的 CLI 绝大多数用它，unc / cnb / kdocs 都是）：
//
//   Available Commands:       → 子命令树
//   Flags:                    → 本命令专属参数（Global Flags 不算，那是每个命令都有的）
//   Usage: ... [PATH...]      → 位置参数
//
// 解析失败不抛错：返回 warnings，让上层退化成一个「跑任意子命令」的兜底工具。
// 宁可少一个参数说明，也不能整个连接器导入不了。

import { spawn } from 'node:child_process';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_HELP = 64 * 1024;

// 动词 → 风险等级。按词切分（ls-root → ls + root），不按子串匹配：
// 「remove」里的「move」不该让它变成写操作，反过来「ls-root」必须认出 ls。
const HIGH_WORDS = new Set(['rm', 'delete', 'del', 'remove', 'uninstall', 'stop', 'kill', 'restart',
  'reboot', 'shutdown', 'format', 'drop', 'purge', 'clear', 'empty', 'truncate', 'wipe', 'destroy',
  'cancel', 'reset', 'mkfs', 'eject', 'unlink', 'revoke']);
const WRITE_WORDS = new Set(['create', 'add', 'mkdir', 'touch', 'cp', 'copy', 'mv', 'move', 'rename',
  'upload', 'put', 'post', 'set', 'update', 'edit', 'write', 'tee', 'tag', 'quota', 'install', 'start',
  'run', 'exec', 'import', 'restore', 'recover', 'retry', 'resume', 'pause', 'sync', 'enable', 'disable',
  'mount', 'unmount', 'chmod', 'chown', 'link', 'apply', 'rebuild', 'pull', 'push', 'commit', 'build',
  'publish', 'share', 'invite', 'grant', 'patch', 'save', 'new', 'login', 'logout', 'auth', 'register']);
const READ_WORDS = new Set(['ls', 'list', 'get', 'show', 'info', 'stat', 'cat', 'head', 'tail', 'df', 'du',
  'ps', 'status', 'version', 'overview', 'search', 'find', 'query', 'smart', 'logs', 'stats', 'md5sum',
  'sha256sum', 'whoami', 'ping', 'iface', 'general', 'tree', 'exists', 'check', 'images', 'containers',
  'volumes', 'networks', 'inspect', 'top', 'events', 'history', 'read', 'view', 'detail', 'disk', 'pool',
  'service', 'process', 'user', 'group', 'health', 'report', 'usage', 'summary', 'describe']);

// 每个命令都会有的通用参数，不该变成工具参数：它们要么已经在 cli.args 里，
// 要么是给调试/授权用的，暴露给模型只会让它乱填。
const SKIP_FLAGS = new Set(['help', 'format', 'output', 'debug', 'dry-run', 'yes', 'verbose',
  'token', 'server-url', 'client-id', 'client-secret', 'stream-timeout', 'timeout', 'insecure', 'config']);

export function classifyRisk(words, flags = []) {
  const set = new Set();
  for (const w of words) for (const x of String(w).toLowerCase().split(/[-_]/)) if (x) set.add(x);
  for (const w of set) if (HIGH_WORDS.has(w)) return 'high';
  // --force / --purge 这种参数本身就是"别问，直接干"的信号
  if (flags.some((f) => ['force', 'purge', 'yes'].includes(f.name))) return 'high';
  for (const w of set) if (WRITE_WORDS.has(w)) return 'write';
  for (const w of set) if (READ_WORDS.has(w)) return 'read';
  // 认不出来的动词按写处理：默认拦住比默认放行安全，
  // 真要放开由用户在应用的「允许的操作等级」里点，而不是我替他猜。
  return 'write';
}

function stripAnsi(s) {
  return String(s || '').replace(ANSI, '').replace(/\r\n/g, '\n');
}

// cobra 的 flag 行：
//   -h, --help        help for ls
//       --limit int   返回条目上限 (default 100)
//   -R, --recursive   递归
function parseFlags(block) {
  const out = [];
  for (const raw of String(block || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^\s+(?:-([A-Za-z0-9]),\s+)?--([A-Za-z0-9][\w-]*)(.*)$/);
    if (!m) continue;
    const short = m[1] || '';
    const name = m[2];
    let rest = m[3] || '';
    // 类型和说明之间至少两个空格；只有一个空格说明这一行是折行的续行
    let type = '';
    let desc = rest.trim();
    const sp = rest.match(/^(.*?)\s{2,}(.*)$/);
    if (sp) {
      type = sp[1].trim();
      desc = sp[2].trim();
    }
    if (SKIP_FLAGS.has(name)) continue;
    const t = /^(int|int32|int64|uint|float|float64|number)$/i.test(type) ? 'number'
      : /^(bool|boolean)$/i.test(type) || type === '' ? 'boolean'
      : /(array|arrayString|strings|stringSlice)$/i.test(type) ? 'array'
      : 'string';
    const def = desc.match(/\(default\s+([^)]*)\)\s*$/i);
    out.push({
      name: name.replace(/-/g, '_'),
      flag: `--${name}`,
      short,
      type: t,          // 是推导出来的 t，不是原始的 type 字符串
      desc: desc.replace(/\(default[^)]*\)\s*$/i, '').trim(),
      default: def ? def[1] : undefined,
    });
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.name) ? false : seen.add(x.name)));
}

function parseCommands(block) {
  const out = [];
  for (const raw of String(block || '').split('\n')) {
    const m = raw.match(/^\s{1,4}([A-Za-z0-9][\w-]*)(\s{2,}(.*))?$/);
    if (!m) continue;
    if (['help', 'completion'].includes(m[1])) continue;
    out.push({ name: m[1], desc: (m[3] || '').trim() });
  }
  return out;
}

// Usage:  unc file ls [PATH...] [flags]
function parsePositionals(usage, commandPath) {
  const first = String(usage || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  const toks = first.split(/\s+/).slice(1);        // 去掉程序名
  let i = 0;
  while (i < toks.length && i < commandPath.length && toks[i] === commandPath[i]) i++;
  const rest = toks.slice(i).filter((t) => t !== '[flags]' && t !== '[command]');
  const out = [];
  for (const t of rest) {
    const m = t.match(/^\[?([A-Za-z][\w-]*)(\.\.\.)?\]?$/) || t.match(/^\[?<([A-Za-z][\w-]*)>(\.\.\.)?\]?$/);
    if (!m) continue;
    const required = !t.startsWith('[');
    out.push({
      name: m[1].toLowerCase().replace(/-/g, '_'),
      pos: out.length,
      type: 'string',
      required,
      desc: required ? '必填' : '可选',
    });
  }
  return out;
}

export function parseHelp(text, { commandPath = [] } = {}) {
  const body = stripAnsi(text);
  const cut = (re) => {
    const m = body.match(re);
    return m ? m[1] : '';
  };
  const commands = parseCommands(cut(/Available Commands:\n([\s\S]*?)(?:\n\n|\nFlags:|\nGlobal Flags:|$)/));
  const localFlags = parseFlags(cut(/\nFlags:\n([\s\S]*?)(?:\n\nGlobal Flags:|\n*$)/));
  const usage = cut(/\nUsage:\n([\s\S]*?)(?:\n\n|$)/);
  // 第一段自然语言就是命令说明（cobra 会把 Long 放在最前面）
  const head = body.split(/\n(?:Usage|Available Commands|Flags|Examples|Aliases):/)[0] || '';
  const desc = head.replace(/\n+/g, ' ').trim().slice(0, 300);
  return {
    desc,
    commands,
    flags: localFlags,
    positionals: parsePositionals(usage, commandPath),
    usage: usage.trim(),
  };
}

function runHelp(bin, argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, argv, { cwd: cwd || undefined, env: { ...process.env, ...(env || {}) }, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, text: '', err: String(e?.message || e) });
      return;
    }
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < MAX_HELP) out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { if (err.length < MAX_HELP) err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: '', err: e?.code === 'ENOENT' ? `找不到可执行文件：${bin}` : String(e?.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !killed && (code === 0 || Boolean(out.trim())), text: out, err: killed ? '超时' : err, code });
    });
  });
}

function safeName(parts) {
  return parts.join('_').replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 60).replace(/^_+|_+$/g, '');
}

function specFrom(pathParts, parsed, groupDesc) {
  const flags = parsed.flags.map((f) => ({
    name: f.name,
    flag: f.flag,
    type: f.type === 'array' ? 'string' : f.type,
    desc: f.desc,
    ...(f.type === 'array' ? { multiple: true } : {}),
  }));
  const params = [...parsed.positionals, ...flags];
  const words = pathParts.flatMap((x) => String(x).split(/[-_]/));
  const titleBits = [groupDesc, parsed.desc].filter(Boolean);
  return {
    name: safeName(pathParts),
    title: (parsed.desc || pathParts.join(' ')).slice(0, 40),
    description: (titleBits.join(' / ') || pathParts.join(' ')).slice(0, 300),
    command: pathParts,
    params,
    risk: classifyRisk(words, parsed.flags),
  };
}

/**
 * 跑一遍 --help，生成工具表。
 * @param {object} o
 * @param {string} o.bin
 * @param {string[]} [o.prefix]  紧跟在 bin 后面（解释器 + 脚本场景）
 * @param {string[]} [o.args]    固定参数（不含 --help）
 * @param {object} [o.env]
 * @param {string} [o.cwd]
 * @param {number} [o.depth]     最多往下几层，默认 3
 * @param {number} [o.maxTools]  上限，默认 400
 * @param {number} [o.perCallMs]
 */
export async function introspect({ bin, prefix = [], args = [], env = {}, cwd = null, depth = 3, maxTools = 400, perCallMs = 6000 } = {}) {
  const tools = [];
  const warnings = [];
  const seen = new Set();

  const head = [...prefix, ...args];
  const root = await runHelp(bin, [...head, '--help'], { cwd, env, timeoutMs: perCallMs });
  if (!root.ok) {
    return {
      tools: [],
      warnings: [`跑不了 \`${bin} --help\`：${(root.err || '没有输出').trim().slice(0, 200)}`],
    };
  }
  const rootParsed = parseHelp(root.text, { commandPath: [] });
  if (!rootParsed.commands.length) {
    warnings.push('根命令没有子命令列表，只能提供「执行任意子命令」这一个兜底工具。');
    return { tools: [], warnings, root: rootParsed };
  }

  const walk = async (pathParts, groupDesc, level) => {
    if (tools.length >= maxTools) return;
    const r = await runHelp(bin, [...head, ...pathParts, '--help'], { cwd, env, timeoutMs: perCallMs });
    if (!r.ok) {
      warnings.push(`\`${pathParts.join(' ')}\` 的帮助读不到（${(r.err || '').trim().slice(0, 80)}）`);
      return;
    }
    const parsed = parseHelp(r.text, { commandPath: pathParts });
    if (parsed.commands.length && level < depth) {
      for (const c of parsed.commands) {
        await walk([...pathParts, c.name], parsed.desc || c.desc || groupDesc, level + 1);
      }
      if (!parsed.commands.length) return;
      // 有子命令的节点自己也可能能直接跑（如 `docker ps` 没有下级）——
      // 这里不再为它单独建工具，避免「docker」这种什么都没有的工具把模型带偏。
      return;
    }
    const name = safeName(pathParts);
    if (!name || seen.has(name)) return;
    seen.add(name);
    tools.push(specFrom(pathParts, parsed, groupDesc));
  };

  for (const g of rootParsed.commands) {
    await walk([g.name], g.desc || '', 1);
  }

  // 只读的排前面：模型在候选里挑时，靠前的更容易被选中，而只读错了没代价
  const order = { read: 0, write: 1, high: 2 };
  tools.sort((a, b) => (order[a.risk] - order[b.risk]) || a.name.localeCompare(b.name));
  return { tools, warnings, root: rootParsed };
}
