// 登录 / 首次设置密码的端到端测试。
//
// 起一个真的 server.js 子进程，用真的 HTTP 请求走完：
// 未登录被拦 → 设密码 → 自动登录 → 退出 → 密码错 → 登录 → 改密 → 锁定。
// 不 mock 任何认证逻辑：这一层的 bug 只在"真实请求 + 真实 Cookie"下才暴露。
//
// 用法：npm run test:auth

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const dataDir = path.join(os.tmpdir(), 'wxgw-auth-' + Date.now());
fs.mkdirSync(dataDir, { recursive: true });
const cfgFile = path.join(dataDir, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ apps: [] }));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GATEWAY_DATA: dataDir,
    GATEWAY_CONFIG: cfgFile,
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

// ---- 请求小工具 -------------------------------------------------------

let cookie = '';

function cookieOf(res) {
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    const m = /^wxgw_session=([^;]*)/.exec(c);
    if (m) return m[1] === '' ? '' : `wxgw_session=${m[1]}`;
  }
  return null;
}

async function req(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.cookie !== undefined ? opts.cookie : cookie) {
    headers.Cookie = opts.cookie !== undefined ? opts.cookie : cookie;
  }
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const next = cookieOf(res);
  if (next !== null) cookie = next;
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* html 或空 */ }
  return { status: res.status, json, text, location: res.headers.get('location'), type: res.headers.get('content-type') };
}

// ---- 等服务起来 -------------------------------------------------------

console.log('\n=== 启动 ===');
let up = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(BASE + '/api/health');
    if (r.ok) { up = true; break; }
  } catch { /* 还没监听 */ }
  await sleep(100);
}
ok('服务已启动', up, childLog.slice(-300));
if (!up) {
  child.kill();
  process.exit(1);
}

// ---- ① 未登录拦得住 ---------------------------------------------------

console.log('\n=== ① 未登录 ===');
const home = await req('GET', '/', undefined, { cookie: '' });
ok('打开首页被甩到 /login', home.status === 302 && home.location === '/login', `${home.status} ${home.location}`);

const loginPage = await req('GET', '/login', undefined, { cookie: '' });
ok('登录页能打开', loginPage.status === 200 && /设置访问密码|登录/.test(loginPage.text));
ok('登录页不引用外部资源', !/https?:\/\//.test(loginPage.text.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')));

// 图标必须在"没有会话"时也拿得到：登录页是第一屏，图标被 302 到 /login
// 的话浏览器收到的是 HTML，标签栏还是空白。
const fav = await req('GET', '/favicon.svg', undefined, { cookie: '' });
ok('未登录也能取到标签页图标', fav.status === 200 && /^image\/svg\+xml/.test(fav.type || ''), `${fav.status} ${fav.type}`);
ok('图标是真的 svg 内容', fav.text.trimStart().startsWith('<svg'));
const favIco = await req('GET', '/favicon.ico', undefined, { cookie: '' });
ok('/favicon.ico 也回图标而不是 HTML', favIco.status === 200 && /^image\/svg\+xml/.test(favIco.type || ''), `${favIco.status} ${favIco.type}`);

const s0 = await req('GET', '/api/auth/session', undefined, { cookie: '' });
ok('session 说还没初始化', s0.json?.initialized === false, JSON.stringify(s0.json));
ok('session 说未登录', s0.json?.loggedIn === false);
ok('暴露了密码长度下限', s0.json?.minPassword === 8, String(s0.json?.minPassword));

const st0 = await req('GET', '/api/state', undefined, { cookie: '' });
ok('业务接口返回 401', st0.status === 401, String(st0.status));
ok('401 带 needLogin 标记', st0.json?.needLogin === true);

const cfg0 = await req('GET', '/api/settings', undefined, { cookie: '' });
ok('设置接口也拦住了', cfg0.status === 401, String(cfg0.status));

// ---- ② 设置密码的各种挡法 ---------------------------------------------

console.log('\n=== ② 首次设置密码 ===');
const weak = await req('POST', '/api/auth/setup', { password: 'abc', confirm: 'abc' }, { cookie: '' });
ok('太短被拒', weak.status === 400 && weak.json?.code === 'weak_password', JSON.stringify(weak.json));

const digits = await req('POST', '/api/auth/setup', { password: '12345678', confirm: '12345678' }, { cookie: '' });
ok('纯数字被拒', digits.status === 400 && /全是数字/.test(digits.json?.error || ''), JSON.stringify(digits.json));

const mismatch = await req('POST', '/api/auth/setup', { password: 'goodpass123', confirm: 'goodpass124' }, { cookie: '' });
ok('两次不一致被拒', mismatch.status === 400 && mismatch.json?.code === 'mismatch');

const notYet = await req('GET', '/api/state', undefined, { cookie: '' });
ok('被拒之后仍未登录', notYet.status === 401);

const setup = await req('POST', '/api/auth/setup', { password: 'goodpass123', confirm: 'goodpass123' }, { cookie: '' });
ok('设置成功', setup.status === 200 && setup.json?.autoLogin === true, JSON.stringify(setup.json));
ok('设置后直接拿到会话', /^wxgw_session=[0-9a-f]{64}$/.test(cookie), cookie.slice(0, 24));

// 落盘检查：只存哈希，明文绝不出现
const authFile = path.join(dataDir, 'auth.json');
const raw = fs.readFileSync(authFile, 'utf8');
const saved = JSON.parse(raw);
ok('auth.json 已写入', fs.existsSync(authFile));
const fileMode = fs.statSync(authFile).mode & 0o777;
// Windows 的 NTFS 没有 unix 权限位，stat 出来永远是 666/777，这条只能在 Linux/macOS 上验
ok('文件权限 0600（Windows 除外）', process.platform === 'win32' || fileMode === 0o600, fileMode.toString(8));
ok('存的是 scrypt 哈希', saved.algo === 'scrypt' && saved.hash.length > 20);
ok('明文密码不在文件里', !raw.includes('goodpass123'));
ok('哈希不是 base64 之外的乱码', /^[A-Za-z0-9+/=]+$/.test(saved.hash));
ok('有盐', typeof saved.salt === 'string' && saved.salt.length >= 16);

// ---- ③ 登录态 ---------------------------------------------------------

console.log('\n=== ③ 登录后 ===');
const st1 = await req('GET', '/api/state');
ok('业务接口可用', st1.status === 200 && typeof st1.json?.version === 'string', String(st1.status));
ok('返回的版本是新的', st1.json?.version === '0.3.3', st1.json?.version);

const loginWhenIn = await req('GET', '/login');
ok('已登录再访问 /login 会跳首页', loginWhenIn.status === 302 && loginWhenIn.location === '/', `${loginWhenIn.status} ${loginWhenIn.location}`);

const s1 = await req('GET', '/api/auth/session');
ok('session 说已登录', s1.json?.loggedIn === true);
ok('session 不再暴露会话数量之类', s1.json?.sessionCount === undefined);

// 自检接口：没配 AI 时必须如实说"不会生效"，而不是装作走了 AI
const probe = await req('POST', '/api/llm/probe', { text: '有几封未读邮件' });
ok('自检接口可用', probe.status === 200 && probe.json?.state, `${probe.status}`);
ok('没配 AI 时说清楚不会生效', probe.json?.state?.on === false && /开关|服务商/.test(probe.json?.state?.reason || ''),
  JSON.stringify(probe.json?.state));
ok('自检报告了当前档位', typeof probe.json?.state?.mode === 'string', String(probe.json?.state?.mode));
ok('自检只给结论、不执行工具', probe.json?.via !== 'llm' || probe.json?.state?.on === true, JSON.stringify(probe.json));

// 重复设置密码必须被拒（first-run takeover 的兜底）
const again = await req('POST', '/api/auth/setup', { password: 'another123', confirm: 'another123' });
ok('重复设置被拒', again.status === 409 && again.json?.code === 'already_initialized', `${again.status} ${JSON.stringify(again.json)}`);

// ---- ④ 退出 -----------------------------------------------------------

console.log('\n=== ④ 退出登录 ===');
const out = await req('POST', '/api/auth/logout');
ok('退出返回 ok', out.status === 200);
ok('退出时清掉了 Cookie', cookie === '');
const afterOut = await req('GET', '/api/state');
ok('退出后业务接口 401', afterOut.status === 401, String(afterOut.status));

// ---- ⑤ 密码校验 -------------------------------------------------------

console.log('\n=== ⑤ 登录 ===');
const bad = await req('POST', '/api/auth/login', { password: 'wrongpass' });
ok('错密码 401', bad.status === 401 && bad.json?.code === 'bad_password', `${bad.status} ${JSON.stringify(bad.json)}`);
ok('提示里带剩余次数', /还可尝试 4 次/.test(bad.json?.error || ''), bad.json?.error);

const good = await req('POST', '/api/auth/login', { password: 'goodpass123', keep: true });
ok('正确密码登录成功', good.status === 200, JSON.stringify(good.json));
ok('拿到新会话', /^wxgw_session=[0-9a-f]{64}$/.test(cookie));
ok('勾保持登录给 7 天', good.json?.expiresIn === 7 * 24 * 3600, String(good.json?.expiresIn));

// ---- ⑥ 改密码 ---------------------------------------------------------

console.log('\n=== ⑥ 修改密码 ===');
const chBad = await req('POST', '/api/auth/password', { oldPassword: 'nope', newPassword: 'newpass456', confirm: 'newpass456' });
// 这里必须是 400 不是 401：401 会被前端当成"会话失效"直接踢到登录页
ok('原密码错返回 400（不是 401）', chBad.status === 400 && chBad.json?.code === 'bad_password', `${chBad.status} ${JSON.stringify(chBad.json)}`);
ok('原密码错不会把人踢下线', cookie !== '');

const chWeak = await req('POST', '/api/auth/password', { oldPassword: 'goodpass123', newPassword: '123', confirm: '123' });
ok('新密码太短被拒', chWeak.status === 400 && chWeak.json?.code === 'weak_password');

const chOk = await req('POST', '/api/auth/password', { oldPassword: 'goodpass123', newPassword: 'newpass456', confirm: 'newpass456' });
ok('改密成功', chOk.status === 200 && chOk.json?.relogin === true, JSON.stringify(chOk.json));
ok('改密后当前会话也作废', cookie === '');

const oldPw = await req('POST', '/api/auth/login', { password: 'goodpass123' });
ok('旧密码登不进来', oldPw.status === 401 && oldPw.json?.code === 'bad_password');

const newPw = await req('POST', '/api/auth/login', { password: 'newpass456' });
ok('新密码能登录', newPw.status === 200);
ok('会话可以再用', (await req('GET', '/api/state')).status === 200);

await req('POST', '/api/auth/logout');

// ---- ⑦ 连续失败锁定 ---------------------------------------------------

console.log('\n=== ⑦ 连续失败锁定 ===');
let lastLock = null;
for (let i = 1; i <= 5; i++) {
  const r = await req('POST', '/api/auth/login', { password: 'definitely-wrong' });
  if (r.status === 429) lastLock = r.json;
}
ok('连错 5 次触发 429', lastLock !== null, childLog.slice(-200));
ok('锁定带倒计时秒数', typeof lastLock?.retryAfter === 'number' && lastLock.retryAfter > 0, JSON.stringify(lastLock));
ok('锁定文案说清要等多久', /秒|分钟/.test(lastLock?.error || ''), lastLock?.error);

const correctWhileLocked = await req('POST', '/api/auth/login', { password: 'newpass456' });
ok('锁定期内正确密码也被拒', correctWhileLocked.status === 429, `${correctWhileLocked.status} ${JSON.stringify(correctWhileLocked.json)}`);

const sessWhileLocked = await req('GET', '/api/auth/session', undefined, { cookie: '' });
ok('session 如实报告锁定剩余', sessWhileLocked.json?.lockedFor > 0, JSON.stringify(sessWhileLocked.json));

// ---- 收尾 -------------------------------------------------------------

child.kill();
await sleep(200);
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }

console.log(`\n${process.exitCode ? '✗ 有失败项' : `全部通过：${pass} 项`}`);
