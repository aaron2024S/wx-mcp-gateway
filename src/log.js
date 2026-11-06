// 极简日志：控制台 + 内存环形缓冲（给 UI 实时看）+ 可选文件。
// 不引 pino/winston——本项目的日志只有一个人在偶尔看，字段化没有意义。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export class Log {
  constructor({ level = 'info', buffer = 400, file = null } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.ring = [];
    this.cap = buffer;
    this.file = file;
    if (file) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 已有 */ }
    }
  }

  _emit(level, scope, msg) {
    if (LEVELS[level] > this.level) return;
    const entry = { t: Date.now(), level, scope, msg: String(msg) };
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift();

    const ts = new Date(entry.t).toISOString().slice(11, 19);
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.msg}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);

    if (this.file) {
      // 日志写失败绝不能让主流程挂
      try { fs.appendFileSync(this.file, new Date(entry.t).toISOString() + ' ' + level + ' [' + scope + '] ' + entry.msg + '\n'); }
      catch { /* 磁盘满/只读，忽略 */ }
    }
  }

  error(scope, msg) { this._emit('error', scope, msg); }
  warn(scope, msg) { this._emit('warn', scope, msg); }
  info(scope, msg) { this._emit('info', scope, msg); }
  debug(scope, msg) { this._emit('debug', scope, msg); }

  recent(n = 100) {
    return this.ring.slice(-n);
  }

  child(scope) {
    return {
      error: (m) => this.error(scope, m),
      warn: (m) => this.warn(scope, m),
      info: (m) => this.info(scope, m),
      debug: (m) => this.debug(scope, m),
    };
  }
}

export function errText(e) {
  if (!e) return '未知错误';
  if (e.detail) {
    const d = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
    return `${e.message}（${d.slice(0, 160)}）`;
  }
  return e.message || String(e);
}
