// 把连接器的命令行程序装进容器。
//
// 为什么不用官方 install.sh：alpine 镜像里没有 curl，而且 `curl | sh` 等于把
// 一个远程脚本直接执行掉。这里改成「下载 → 校验 sha256 → 自己解包 → 找到可执行文件」，
// 全程可以审计，也不依赖镜像里装了什么。
//
// 装到 /data/connectors/<id>/bin 而不是镜像里：
//   · 容器重建不丢（/data 是卷）
//   · 升级不用重发镜像，换文件 + 重启容器即可
//   · 多架构不用为每个 arch 出一个镜像层

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAX_BYTES = 200 * 1024 * 1024;

export class InstallError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'InstallError';
    this.detail = detail || null;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- tar -----------------------------------------------------------------
// 只认 ustar/pax 的常规文件与目录。够解 Go 项目打的发布包（unc 就是 tar.gz）。
function untar(buf) {
  const files = [];
  let off = 0;
  let longName = '';
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeRaw = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeRaw || '0', 8) || 0;
    const flag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    let name = longName || (prefix ? `${prefix}/${nameRaw}` : nameRaw);
    if (flag === 'L') {           // GNU long name：下一块才是真正的头
      longName = buf.subarray(off + 512, off + 512 + size).toString('utf8').replace(/\0.*$/, '');
      off += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    longName = '';
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (!name || name === './') continue;
    if (flag === '5') { files.push({ name, dir: true }); continue; }
    if (flag !== '0' && flag !== '\0' && flag !== '7') continue;
    files.push({ name, dir: false, data });
  }
  return files;
}

// ---- zip -----------------------------------------------------------------
// 自己解，不依赖 unzip（alpine 没装）。只支持 store / deflate 两种压缩方式，
// 这两者覆盖了 99% 的发布包。
function unzip(buf) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) throw new InstallError('这个 zip 读不出来（找不到目录区）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) { files.push({ name, dir: true }); continue; }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue;                       // 别的压缩方式不支持，跳过
    files.push({ name, dir: false, data });
  }
  return files;
}

function safeJoin(root, name) {
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) return null;   // 目录穿越
  return target;
}

/**
 * 下载并解包一个连接器程序。
 * @param {object} o
 * @param {string} o.url
 * @param {string} [o.sha256]   给了就强制校验
 * @param {string} o.destDir    解包目录（会被创建）
 * @param {string} [o.binName]  想要的可执行文件名，用来在多文件包里挑
 * @returns {Promise<{bin:string, files:number, bytes:number, sha256:string, found:string[]}>}
 */
export async function installFromUrl({ url, sha256: wantSha, destDir, binName = '', timeoutMs = 120000 }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new InstallError('下载地址必须是 http:// 或 https://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    throw new InstallError(e?.name === 'AbortError' ? '下载超时' : `下载失败：${e?.message || e}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw new InstallError(`下载失败：HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  clearTimeout(timer);
  if (buf.length > MAX_BYTES) throw new InstallError(`包太大（${(buf.length / 1e6).toFixed(0)} MB）`);
  if (!buf.length) throw new InstallError('下载到的文件是空的');

  const got = sha256(buf);
  if (wantSha && got.toLowerCase() !== String(wantSha).toLowerCase()) {
    throw new InstallError('校验失败：下载到的文件和你填的 sha256 不一致', { want: wantSha, got });
  }

  let entries;
  if (buf[0] === 0x1f && buf[1] === 0x8b) entries = untar(zlib.gunzipSync(buf));
  else if (buf[0] === 0x50 && buf[1] === 0x4b) entries = unzip(buf);
  else entries = [{ name: path.basename(new URL(url).pathname) || 'bin', dir: false, data: buf }];

  fs.mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const e of entries) {
    const target = safeJoin(destDir, e.name);
    if (!target) continue;
    if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    // 包里带的脚本/二进制都给执行位：以 / 开头或没有扩展名的通常就是它们
    if (!path.extname(target)) { try { fs.chmodSync(target, 0o755); } catch { /* 卷不支持 */ } }
    n += 1;
  }

  // 找可执行文件：优先用户点名的名字，其次所有无扩展名的文件里最大的那个
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else found.push(p);
    }
  };
  walk(destDir);
  const noExt = found.filter((f) => !path.extname(f));
  const pick = (binName && noExt.find((f) => path.basename(f) === binName))
    || noExt.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
    || found[0];
  if (!pick) throw new InstallError('包里没有解出任何文件');
  try { fs.chmodSync(pick, 0o755); } catch { /* 卷不支持 */ }

  return { bin: pick, files: n, bytes: buf.length, sha256: got, found: found.slice(0, 20) };
}
