// 落盘工具。刻意不用 SQLite：本项目的数据量（一个用户、几百条日志、几个应用）
// 用 JSON 文件更快、更好备份、更好排查——出问题时 cat 一下就能看，不用开客户端。
// 唯一要认真做的是「原子写」：先写 .tmp 再 rename，避免断电时留下半个文件。
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// mode: 0600 用于存放凭据的文件。Windows 上 chmod 基本无效，容器（Linux）里生效。
export function writeJson(file, obj, { mode = 0o644 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch { /* Windows 不支持，忽略 */ }
}

export function readJsonl(file, limit = 0) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = txt.split('\n').filter(Boolean);
  const pick = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const l of pick) {
    try { out.push(JSON.parse(l)); } catch { /* 半行（进程被杀）跳过 */ }
  }
  return out;
}

export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// 日志行数超过 2 倍保留量时压缩一次（留最后 N 条），避免文件无限增长。
// 只在写入路径上偶尔触发，不做定时器——少一个后台任务就少一处泄漏。
export function trimJsonl(file, keep) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.size < 512 * 1024 && keep > 200) return;
  const rows = readJsonl(file, 0);
  if (rows.length <= keep * 2) return;
  const kept = rows.slice(-keep);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
