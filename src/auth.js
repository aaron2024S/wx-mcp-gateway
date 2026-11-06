// 单用户密码登录：首次打开必须设一个密码，之后用它进入控制台。
//
// 为什么要强制：这个进程手里攥着 data/ 目录的全部机密——微信 bot_token、
// 各应用的访问令牌、AI 的 API key。控制台不设密码，等于把"用你的微信
// 驱动你的 NAS"这件事交给同一网段的任何人。所以和 dockhelm 一样，
// 首启不让跳过，也不提供"无密码模式"。
//
// 存什么：只存 scrypt 派生的哈希，明文既不落盘、也不进日志。
// 为什么用 scrypt 而不是 bcrypt：scrypt 在 Node 标准库里，零依赖是本项目的底线。
// N=32768/r=8 单次约 80~150ms，对"人能忍、爆破很贵"这个区间够用。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE_NAME = 'wxgw_session';

/** 密码长度下限。控制台等价于「微信 + 全部应用凭据」，6 位在离线爆破下只是多花几分钟。 */
export const MIN_PASSWORD = 8;
/** 连续失败多少次锁定。 */
export const MAX_FAILURES = 5;
/** 锁定窗口（滑动窗口：命中后每有一次失败滑出窗口才放行）。 */
export const LOCK_WINDOW_MS = 5 * 60 * 1000;
/** 勾「保持登录」的会话时长。 */
export const TTL_KEEP_MS = 7 * 24 * 3600 * 1000;
/** 不勾时的服务端兜底上限——防「浏览器恢复标签页」让会话无限续命。 */
export const TTL_MS = 24 * 3600 * 1000;

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function scryptKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 密码规则集中在一处：首启、改密两个入口都走它，避免某个入口能设 123456。 */
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw new AuthError('weak_password', `密码至少需要 ${MIN_PASSWORD} 位`);
  }
  if (pw.length > 200) {
    throw new AuthError('weak_password', '密码太长了，200 位以内即可');
  }
  if (/^\d+$/.test(pw)) {
    throw new AuthError('weak_password', '密码不能全是数字，请混入字母或符号');
  }
  if (/^\s+$/.test(pw)) {
    throw new AuthError('weak_password', '密码不能全是空格');
  }
}

/** 锁定剩余时间 → 给用户看的文案。不满 1 分钟按秒报，否则会「说 1 分钟其实还剩 3 秒」。 */
export function lockedHint(leftMs) {
  if (leftMs <= 0) return '';
  const sec = Math.ceil(leftMs / 1000);
  if (sec < 60) return `尝试次数过多，请约 ${sec} 秒后再试`;
  return `尝试次数过多，请约 ${Math.ceil(sec / 60)} 分钟后再试`;
}

export class Auth {
  constructor({ dataDir, log }) {
    this.file = path.join(dataDir, 'auth.json');
    this.log = log;
    this.data = { version: 1, algo: 'scrypt', salt: '', hash: '', createdAt: null, updatedAt: null };
    this.sessions = new Map();   // token -> { expiresAt, ip, ua, createdAt }
    this.failures = new Map();   // ip -> number[]（失败时刻）
    this.load();
    // 过期会话定期清，避免长期运行后 Map 只增不减。
    // unref 让这个定时器不阻止进程退出。
    this.timer = setInterval(() => this.purge(), 10 * 60 * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;   // 未初始化，正常
      this.log?.warn?.('auth', `读不到 auth.json：${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 坏文件不能让进程起不来：NAS 上那意味着只能进 SSH 手删。
      // 挪到一边、按未初始化处理——能改这个文件的人本来就能直接删掉它，安全性不变。
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
        this.log?.error?.('auth', `auth.json 解析失败（${e.message}），已改名为 ${path.basename(aside)}，请重新设置密码`);
      } catch (mvErr) {
        this.log?.error?.('auth', `auth.json 解析失败且无法移走：${mvErr.message}`);
      }
      return;
    }
    if (parsed && typeof parsed.hash === 'string' && typeof parsed.salt === 'string') {
      this.data = { ...this.data, ...parsed };
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 先写临时文件、fsync、再 rename：直接写会在掉电/被 kill 时留下半截 JSON，
    // 而半截 auth.json 等于下次启动解析失败。
    const tmp = path.join(dir, `.auth-${process.pid}-${Date.now()}.tmp`);
    const body = Buffer.from(JSON.stringify(this.data, null, 2));
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      // openSync 的 mode 会被 umask 削，显式 chmod 一次才是确定的 0600
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  get initialized() {
    return Boolean(this.data.hash);
  }

  /** 首次设置密码。判断「有没有设过」和写入必须在同一个同步段里，否则两个并发请求会互相覆盖。 */
  async setup(password, confirm, ip, ua) {
    if (password !== confirm) throw new AuthError('mismatch', '两次输入的密码不一致');
    checkPassword(password);
    const salt = crypto.randomBytes(16);
    const hash = await scryptKey(password, salt);
    if (this.initialized) {
      throw new AuthError('already_initialized', '密码已经设置过了');
    }
    const now = new Date().toISOString();
    this.data = {
      version: 1,
      algo: 'scrypt',
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    this.sessions.clear();
    this.log?.info?.('auth', `已设置访问密码（来源 ${ip || '未知'}）`);
    return this.#issue(ip, ua, false);
  }

  /** 校验密码并签发会话。失败会累计到该 IP 的滑动窗口。 */
  async login(password, ip, ua, keep) {
    const left = this.lockedFor(ip);
    if (left > 0) throw new AuthError('locked', lockedHint(left));
    if (!this.initialized) throw new AuthError('not_initialized', '还没有设置密码');

    const expected = Buffer.from(this.data.hash, 'base64');
    const actual = await scryptKey(String(password ?? ''), Buffer.from(this.data.salt, 'base64'));
    // 长度一定相同（都是 keylen），直接恒定时间比较
    const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (!ok) {
      this.recordFailure(ip);
      const wait = this.lockedFor(ip);
      if (wait > 0) {
        this.log?.warn?.('auth', `来源 ${ip} 连续密码错误，已锁定`);
        throw new AuthError('locked', lockedHint(wait));
      }
      const rest = MAX_FAILURES - this.failuresFor(ip);
      throw new AuthError('bad_password', `密码错误，还可尝试 ${Math.max(rest, 0)} 次`);
    }
    this.clearFailures(ip);
    this.log?.info?.('auth', `登录成功（来源 ${ip}）`);
    return this.#issue(ip, ua, keep);
  }

  #issue(ip, ua, keep) {
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = keep ? TTL_KEEP_MS : TTL_MS;
    this.sessions.set(token, {
      expiresAt: Date.now() + ttl,
      createdAt: new Date().toISOString(),
      ip: ip || '',
      ua: ua || '',
    });
    return { token, ttl, keep };
  }

  validate(token) {
    if (!token) return false;
    const s = this.sessions.get(token);
    if (!s) return false;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  /** 改密码：必须给旧密码，改完所有会话作废（别的设备上被忘掉的登录跟着失效）。 */
  async changePassword(oldPassword, newPassword, confirm) {
    if (!this.initialized) throw new AuthError('not_initialized', '还没有设置密码');
    if (newPassword !== confirm) throw new AuthError('mismatch', '两次输入的新密码不一致');
    checkPassword(newPassword);
    const expected = Buffer.from(this.data.hash, 'base64');
    const actual = await scryptKey(String(oldPassword ?? ''), Buffer.from(this.data.salt, 'base64'));
    if (!(actual.length === expected.length && crypto.timingSafeEqual(actual, expected))) {
      throw new AuthError('bad_password', '原密码不正确');
    }
    const salt = crypto.randomBytes(16);
    const hash = await scryptKey(newPassword, salt);
    this.data.salt = salt.toString('base64');
    this.data.hash = hash.toString('base64');
    this.data.updatedAt = new Date().toISOString();
    this.save();
    this.sessions.clear();
    this.log?.info?.('auth', '访问密码已修改，所有登录会话已失效');
  }

  sessionCount() {
    this.purge();
    return this.sessions.size;
  }

  purge() {
    const now = Date.now();
    for (const [t, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(t);
    }
    for (const [ip, list] of this.failures) {
      const kept = list.filter((ts) => now - ts < LOCK_WINDOW_MS);
      if (kept.length) this.failures.set(ip, kept);
      else this.failures.delete(ip);
    }
  }

  recordFailure(ip) {
    const key = ip || 'unknown';
    const now = Date.now();
    const list = (this.failures.get(key) || []).filter((ts) => now - ts < LOCK_WINDOW_MS);
    list.push(now);
    this.failures.set(key, list);
  }

  clearFailures(ip) {
    this.failures.delete(ip || 'unknown');
  }

  failuresFor(ip) {
    const now = Date.now();
    return (this.failures.get(ip || 'unknown') || []).filter((ts) => now - ts < LOCK_WINDOW_MS).length;
  }

  /**
   * 还要等多久才放行。
   *
   * 锁定是滑动窗口，所以解锁时刻不是「最后一次失败 + 5 分钟」，而是
   * 第 (n-MAX+1) 早的那次失败滑出窗口的瞬间——只有它掉出去，计数才跌破上限。
   */
  lockedFor(ip) {
    const list = this.failures.get(ip || 'unknown') || [];
    if (list.length < MAX_FAILURES) return 0;
    const unlockAt = list[list.length - MAX_FAILURES] + LOCK_WINDOW_MS;
    const left = unlockAt - Date.now();
    return left > 0 ? left : 0;
  }
}
