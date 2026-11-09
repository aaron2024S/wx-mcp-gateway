// 验证配置合并层：config.json 手写配置 / 界面改动 / 密钥 这三层谁盖谁。
// 这一层出错的症状是「改了没反应」或「对端突然 401」，而界面上一切正常，
// 所以必须用断言把顺序钉死。用法：npm run test:store

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppStore } from '../src/appstore.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxgw-store-'));

// 模拟「用户手写了 config.json」：里面已经有凭据
const baseConfig = {
  apps: [{
    id: 'mail',
    label: '邮箱',
    url: 'http://mailnest:8006/mcp',
    auth: { type: 'bearer', token: 'CFG-TOKEN' },
    allow_risk: ['read'],
  }],
  llm: {
    enabled: true,
    default: 'deepseek',
    providers: {
      deepseek: {
        label: 'DeepSeek',
        type: 'openai',
        base_url: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        api_key: 'CFG-KEY',
      },
      // 只存在于 config.json 里的第二家，用来验证"界面能删掉它"
      spare: {
        label: '备用',
        type: 'openai',
        base_url: 'https://spare.example/v1',
        model: 'spare-1',
        api_key: 'SPARE-KEY',
      },
    },
  },
};

const s = new AppStore({ dataDir: dir, baseConfig, log: null });
const tokenOf = (id) => s.resolvedApps().find((a) => a.id === id)?.auth?.token;

console.log('\n[1] 初始状态');
eq('config.json 里的 token 生效', tokenOf('mail'), 'CFG-TOKEN');
ok('界面视图知道已设置令牌', s.list().find((a) => a.id === 'mail')?.hasToken === true);

console.log('\n[2] 界面视图不能泄露凭据');
const listJson = JSON.stringify(s.list());
ok('list() 里没有 token 原值', !listJson.includes('CFG-TOKEN'), listJson.slice(0, 120));
ok('list() 里没有 token 字段', !/"token"/.test(listJson));
const provJson = JSON.stringify(s.providers());
ok('providers() 里没有 api_key 原值', !provJson.includes('CFG-KEY'), provJson.slice(0, 120));
ok('providers() 用 hasKey 表示已设置', s.providers().deepseek.hasKey === true);

console.log('\n[3] 界面只改名字，不能把凭据改没');
s.upsert({ ...s.list()[0], label: '邮箱2' }, '');
eq('token 沿用 config.json 那份', tokenOf('mail'), 'CFG-TOKEN');
eq('名字确实改了', s.list().find((a) => a.id === 'mail').label, '邮箱2');
ok('仍然标记为已设置', s.list().find((a) => a.id === 'mail').hasToken === true);

console.log('\n[4] 界面填了新 token 就用新的');
s.upsert({ ...s.list()[0], label: '邮箱2' }, 'UI-TOKEN');
eq('界面填的覆盖 config', tokenOf('mail'), 'UI-TOKEN');

console.log('\n[5] 新增一个纯界面应用');
s.upsert({ id: 'nas', label: 'NAS', url: 'http://nas:5000/mcp', allow_risk: ['read', 'write'] }, 'NAS-TOKEN');
eq('新应用 token 生效', tokenOf('nas'), 'NAS-TOKEN');
ok('allow_risk 按填的存', JSON.stringify(s.list().find((a) => a.id === 'nas').allow_risk) === '["read","write"]');

console.log('\n[6] 凭据落在 0600 的文件里');
const secretsFile = path.join(dir, 'secrets.json');
ok('secrets.json 已生成', fs.existsSync(secretsFile));
// Windows 上 chmod 是模拟的，stat 恒返回 666/444，测不出真实权限。
// 真正要守的是容器（Linux）与 CI runner，所以那里必须严格断言。
if (process.platform === 'win32') {
  console.log('  - 权限位跳过（Windows 不支持 POSIX 权限，由 Linux 上的 CI 校验）');
} else {
  eq('权限是 0600', (fs.statSync(secretsFile).mode & 0o777).toString(8), '600');
}
const saved = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
eq('落盘保存的是界面填的值', saved.tokens.mail, 'UI-TOKEN');

console.log('\n[7] AI 密钥的合并顺序');
eq('初始取 config 的 key', s.resolvedProviders().deepseek.api_key, 'CFG-KEY');
s.upsertProvider({ id: 'deepseek', type: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' }, '');
eq('只改模型名，key 沿用 config', s.resolvedProviders().deepseek.api_key, 'CFG-KEY');
eq('模型名已更新', s.resolvedProviders().deepseek.model, 'deepseek-reasoner');
s.upsertProvider({ id: 'deepseek', type: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' }, 'UI-KEY');
eq('界面填的 key 覆盖 config', s.resolvedProviders().deepseek.api_key, 'UI-KEY');
ok('providers() 此时仍不泄露', !JSON.stringify(s.providers()).includes('UI-KEY'));

console.log('\n[8] 删除应用要连密钥一起清掉');
s.remove('nas');
ok('应用已移除', !s.list().some((a) => a.id === 'nas'));
ok('密钥已移除', !fs.readFileSync(secretsFile, 'utf8').includes('NAS-TOKEN'));

console.log('\n[9] 新实例重新读盘，状态保持一致');
const s2 = new AppStore({ dataDir: dir, baseConfig, log: null });
eq('重启后 token 还在', s2.resolvedApps().find((a) => a.id === 'mail')?.auth?.token, 'UI-TOKEN');
eq('重启后 key 还在', s2.resolvedProviders().deepseek.api_key, 'UI-KEY');

console.log('\n[10] 删掉只存在于 config.json 的服务商');
// 用户报过：界面点了删除，刷新一下它又回来了。原因是这类服务商来自 config.json，
// 旧实现只从 overrides 里删，等于什么都没删。现在记一条墓碑。
s2.saveSettings({ llm_default: 'spare' });
s2.removeProvider('spare');
ok('界面上确实没了', s2.providers().spare === undefined, JSON.stringify(Object.keys(s2.providers())));
ok('给 llm 用的那份也不含它', s2.resolvedProviders().spare === undefined);
eq('默认服务商指向它时被清空', s2.settings().llm_default, '');
eq('config.json 本身没被改', baseConfig.llm.providers.spare?.model, 'spare-1');
const s3 = new AppStore({ dataDir: dir, baseConfig, log: null });
ok('重启后仍然是删掉的状态', s3.providers().spare === undefined);
s3.upsertProvider({ id: 'spare', type: 'openai', base_url: 'https://spare.example/v1', model: 'spare-2' }, '');
ok('重新添加同名就恢复显示（墓碑被撤销）', s3.providers().spare !== undefined);
eq('重新添加后 key 沿用 config 那份', s3.resolvedProviders().spare.api_key, 'SPARE-KEY');

// 出厂配置必须保持"空"：不带应用、不带任何 AI 厂商。
// 写死几家厂商的后果是用户以为只支持那几家——名单一直在变，代码不该替用户决定。
console.log('\n[11] 出厂配置不带任何厂商与应用');
const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
eq('providers 为空', Object.keys(example.llm?.providers || {}).length, 0);
eq('default 为空', example.llm?.default || '', '');
eq('fallback 为空', (example.llm?.fallback || []).length, 0);
eq('apps 为空', (example.apps || []).length, 0);
ok('AI 兜底默认关闭', example.llm?.enabled === false);

console.log('\n[12] 不合法的输入要被挡住');
const rejects = (name, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(name, threw);
};
rejects('缺 id', () => s.upsert({ url: 'http://x/mcp' }, ''));
rejects('id 含非法字符', () => s.upsert({ id: '有 中文', url: 'http://x/mcp' }, ''));
rejects('缺 url', () => s.upsert({ id: 'ok1' }, ''));
rejects('url 不是 http(s)', () => s.upsert({ id: 'ok2', url: 'ftp://x' }, ''));
rejects('provider 缺 base_url', () => s.upsertProvider({ id: 'p1', model: 'm' }, ''));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
