// CLI 连接器整条链路的回归测试。
//
// 覆盖四件事，缺一条就会出现"接进来了但跑不动"：
//   ① --help 解析 → 工具表（子命令树、参数、风险等级）
//   ② 参数 → argv（布尔/值/位置参数/固定参数各就各位）
//   ③ 输出 → 可渲染的结果（JSON、四层嵌套、success:false、非 JSON）
//   ④ 注册表 → 检索/目录（CLI 工具和 MCP 工具在同一张表里，行为一致）
//
// 走的是真子进程：fixture 是个 cobra 风格的假 CLI（scripts/fixtures/fake-cli.js），
// 用 node 当解释器跑（cli.prefix = [脚本路径]），所以不依赖任何本机装了的工具。
//
// 用法：npm run test:cli

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { introspect, classifyRisk, parseHelp } from '../src/cli-tools.js';
import { CliClient, buildArgv, paramsToSchema, humanCliError } from '../src/cli.js';
import { Registry } from '../src/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-cli.js');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); process.exitCode = 1; }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

function base(extra = {}) {
  return { bin: NODE, prefix: [FIXTURE], env: {}, ...extra };
}

async function main() {
  console.log('\n=== ① --help → 工具表 ===');
  const r = await introspect(base({ perCallMs: 8000 }));
  eq('探测到 4 个叶子命令', r.tools.map((t) => t.name).sort(),
    ['file_ls', 'file_mkdir', 'file_rm', 'storage_ls', 'storage_smart', 'system_info'].sort());
  ok('没有解析警告', r.warnings.length === 0, JSON.stringify(r.warnings));
  ok('根命令说明被识别', /Fake NAS/.test(r.root?.desc || ''), r.root?.desc);

  const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
  ok('ls 归为只读', byName.storage_ls.risk === 'read', byName.storage_ls.risk);
  ok('rm 归为高危', byName.file_rm.risk === 'high', byName.file_rm.risk);
  ok('mkdir 归为写入', byName.file_mkdir.risk === 'write', byName.file_mkdir.risk);
  ok('smart 归为只读', byName.storage_smart.risk === 'read', byName.storage_smart.risk);
  ok('命令路径记下来了', JSON.stringify(byName.storage_smart.command) === JSON.stringify(['storage', 'smart']),
    JSON.stringify(byName.storage_smart.command));
  ok('参数里有 --disk', byName.storage_smart.params.some((p) => p.name === 'disk'), JSON.stringify(byName.storage_smart.params));
  ok('通用参数（--format/--token/--help）没被当成工具参数',
    !['format', 'token', 'help', 'insecure'].some((n) => byName.storage_ls.params.some((p) => p.name === n)),
    JSON.stringify(byName.storage_ls.params));

  console.log('\n=== ② 参数 → argv ===');
  const argv = buildArgv(
    { command: ['storage', 'smart'], params: [{ name: 'disk', flag: '--disk' }] },
    ['--format', 'json'],
    { disk: '/dev/sda' },
  );
  eq('子命令 + 参数 + 固定参数各就各位', argv, ['storage', 'smart', '--disk', '/dev/sda', '--format', 'json']);

  const withBool = buildArgv(
    { command: ['file', 'ls'], params: [{ name: 'all', flag: '--all', type: 'boolean' }, { name: 'path', flag: '--path' }] },
    [],
    { all: true, path: '/x y' },
  );
  eq('布尔为真才加 flag，带空格的参数原样成一个 argv', withBool, ['file', 'ls', '--all', '--path', '/x y']);
  eq('布尔为假就不加', buildArgv({ command: ['file', 'ls'], params: [{ name: 'all', type: 'boolean' }] }, [], { all: false }), ['file', 'ls']);

  const positional = buildArgv(
    { command: ['file', 'rm'], params: [{ name: 'path', pos: 0 }, { name: 'force', flag: '--force', type: 'boolean' }] },
    [],
    { path: '/a', force: true },
  );
  eq('位置参数排在 flag 后面', positional, ['file', 'rm', '--force', '/a']);

  const schema = paramsToSchema({ params: [
    { name: 'disk', type: 'string', required: true, desc: '磁盘' },
    { name: 'deep', type: 'boolean' },
  ] });
  eq('schema：必填进 required', schema.required, ['disk']);
  eq('schema：类型映射正确', [schema.properties.disk.type, schema.properties.deep.type], ['string', 'boolean']);

  console.log('\n=== ③ 输出 → 可渲染结果 ===');
  const client = new CliClient({
    id: 'nas', bin: NODE, prefix: [FIXTURE],
    args: ['--format', 'json'], specs: r.tools, timeout: 20000,
  });
  const init = await client.initialize();
  ok('探活拿到版本号', init.serverInfo.version === '1.2.3', JSON.stringify(init.serverInfo));

  const { tools } = await client.listTools();
  ok('listTools 与工具表条数一致', tools.length === r.tools.length, `${tools.length}`);
  ok('工具带 inputSchema', !!tools[0].inputSchema?.properties, JSON.stringify(tools[0].inputSchema).slice(0, 80));

  const ls = await client.callTool('storage_ls', {});
  ok('调通了', ls.isError === false, JSON.stringify(ls).slice(0, 120));
  ok('四层嵌套里的列表被挖出来了', Array.isArray(ls.data?.items) && ls.data.items.length === 2,
    JSON.stringify(ls.data).slice(0, 120));
  ok('条目保留原始字段（渲染层要用 name/size）', ls.data?.items?.[0]?.level === 'RAID5', JSON.stringify(ls.data?.items?.[0]));

  const smart = await client.callTool('storage_smart', { disk: '/dev/sda' });
  ok('带参数的调用把值传到了', /1200|38|PASSED/.test(smart.text || ''), String(smart.text).slice(0, 80));

  // 业务失败（退出码 0 + success:false）必须当失败
  const rm = await client.callTool('file_rm', { path: '/root/x' });
  ok('success:false 判为失败', rm.isError === true, JSON.stringify(rm).slice(0, 120));
  ok('失败原因翻成了人话', /权限/.test(rm.text || ''), rm.text);

  // 缺必填：CLI 自己报错 → 网关要把 stderr 翻成人话，而不是把退出码甩出去
  const noDisk = await client.callTool('storage_smart', {});
  ok('缺参数时报错不崩', noDisk.isError === true, JSON.stringify(noDisk).slice(0, 80));
  ok('报错里说清是参数/命令的问题', /参数|命令|不存在|权限|令牌/.test(noDisk.text || ''), noDisk.text);

  // 未知工具：模型编名字时不能抛
  const ghost = await client.callTool('does_not_exist', {});
  ok('调不存在的工具返回错误而不是抛异常', ghost.isError === true);
  ok('并且告诉模型没有这个命令', /没有「/.test(ghost.text || ''), ghost.text);

  console.log('\n=== ③b 错误翻译 ===');
  ok('自签证书 → 提示开允许自签', /自签|证书/.test(humanCliError('x509: certificate signed by unknown authority')));
  ok('401 → 提示换令牌', /令牌/.test(humanCliError('401 Unauthorized')));
  ok('连不上 → 提示服务名/端口', /连不上|端口/.test(humanCliError('dial tcp 10.0.0.2:9443: connect: connection refused')));
  ok('超时 → 提示超时', /超时|稍后/.test(humanCliError('context deadline exceeded')));
  ok('空输出也有话说', humanCliError('').length > 4, humanCliError(''));
  ok('认不出来的错误截一行给出去', humanCliError('boom\nsecond').length <= 200, humanCliError('boom\nsecond'));

  console.log('\n=== ③c help 解析的边角 ===');
  const weird = parseHelp('这不是 cobra 的输出，只是一段说明。\n随便写点什么。');
  ok('解析不出来时不抛异常', !!weird && Array.isArray(weird.commands) && weird.commands.length === 0);
  ok('说明还是尽量留下', /说明/.test(weird.desc || ''), weird.desc);
  ok('认不出的动词按写处理（宁可拦住）', classifyRisk(['frobnicate']) === 'write', classifyRisk(['frobnicate']));
  ok('--force 这类参数直接升高危', classifyRisk(['ls'], [{ name: 'force' }]) === 'high');
  ok('按词切分，不按子串（remove 里的 move 不算写）', classifyRisk(['remove']) === 'high' && classifyRisk(['ls-root']) === 'read');

  console.log('\n=== ④ 注册表：CLI 与 MCP 同一张表 ===');
  const config = {
    routing: { search_limit: 8 },
    gateway: { call_timeout: 20, confirm_risk: ['high'] },
    apps: [{
      id: 'nas', label: 'NAS', aliases: ['绿联', '存储'],
      transport: 'cli',
      cli: { bin: NODE, prefix: [FIXTURE], args: ['--format', 'json'], tools: r.tools },
      allow_risk: ['read', 'write'],
    }],
  };
  const registry = new Registry(config);
  const entry = await registry.refreshApp(config.apps[0]);
  ok('CLI 应用能上线', entry.status === 'online', `${entry.status} ${entry.error?.message || ''}`);
  ok('工具进索引了', registry.tools.length === r.tools.length, `${registry.tools.length}`);
  ok('工具名带应用前缀', registry.tools[0].key.startsWith('nas.'), registry.tools[0].key);
  ok('风险等级跟着工具表走', registry.find('nas.file_rm')?.risk === 'high', registry.find('nas.file_rm')?.risk);

  const hit = registry.search('存储池用了多少', { limit: 3 });
  ok('中文检索命中存储相关工具', /storage/.test(hit.results[0]?.tool.key || ''), JSON.stringify(hit.results.map((x) => x.tool.key)));
  ok('按别名也能命中整个应用', registry.search('绿联 硬盘 SMART', { limit: 3 }).results[0]?.tool.key === 'nas.storage_smart',
    JSON.stringify(registry.search('绿联 硬盘 SMART', { limit: 3 }).results.map((x) => x.tool.key + ':' + x.score.toFixed(2))));

  const catalog = registry.catalogText();
  ok('目录里只有名字、没有 schema', /NAS/.test(catalog) && !/inputSchema|properties/.test(catalog), catalog.slice(0, 80));
  ok('目录不会把几十个工具全铺开', catalog.length < 600, `${catalog.length} 字`);

  // 真的跑一次 tool call（经过 registry → client，和线上同一条路）
  const tool = registry.find('nas.file_ls');
  const res = await entry.client.callTool(tool.name, { path: '/photo' });
  ok('经注册表取到的客户端能执行', res.isError === false && res.data?.items?.length === 2,
    JSON.stringify(res).slice(0, 120));

  console.log(`\nCLI 用例：${pass} 通过 / ${fail} 失败`);
}

main().catch((e) => {
  console.error('\n异常退出：' + (e?.stack || e));
  process.exitCode = 1;
});
