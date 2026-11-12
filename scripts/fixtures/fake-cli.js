// 一个假的 cobra 风格命令行工具，专门用来测「CLI 连接器」这条链路。
//
// 为什么需要它：网关要把「只提供命令行的应用」接进来，就得先能读懂 `--help`、
// 再把参数拼成 argv、最后把输出解析成能给模型/用户看的东西。这几步全靠解析
// 第三方工具的输出，没有夹具就只能靠"拿真工具试一次"来验证，回归无从谈起。
//
// 输出格式对齐 cobra/pflag 的真实样子（unc / cnb / kdocs 都是这套）：
//   Usage: / Available Commands: / Flags: / Global Flags:
//
// 用法：node fake-cli.js <子命令...> [--flag value]
// 输出：默认 JSON（好验证解析层）

const raw = process.argv.slice(2);
const wantsHelp = raw.includes('--help') || raw.includes('-h');
const argv = raw.filter((a) => a !== '--help' && a !== '-h' && a !== '--format' && a !== 'json');

function fromArgv(name, def = '') {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return argv[i + 1] === undefined ? true : argv[i + 1];
}

const GLOBAL = [
  '',
  'Global Flags:',
  '      --format string   输出格式 (default "json")',
  '      --insecure        跳过证书校验',
  '      --token string    访问令牌',
];

const HELP = {
  '': [
    'Fake NAS 命令行工具，用于验证网关的 CLI 连接器。',
    '',
    'Usage:',
    '  fake-cli [command]',
    '',
    'Available Commands:',
    '  storage     查看存储与硬盘信息',
    '  file        文件操作',
    '  system      系统信息',
    '  help        Help about any command',
    '',
    'Flags:',
    '  -h, --help   help for fake-cli',
    ...GLOBAL,
  ],
  storage: [
    '查看存储池、卷与硬盘状态。',
    '',
    'Usage:',
    '  fake-cli storage [command]',
    '',
    'Available Commands:',
    '  ls          列出存储池',
    '  smart       查看硬盘 SMART',
    '',
    'Flags:',
    '  -h, --help   help for storage',
    ...GLOBAL,
  ],
  'storage ls': [
    '列出所有存储池及其容量。',
    '',
    'Usage:',
    '  fake-cli storage ls [flags]',
    '',
    'Flags:',
    '  -h, --help   help for ls',
    ...GLOBAL,
  ],
  'storage smart': [
    '查看某块硬盘的 SMART 信息。',
    '',
    'Usage:',
    '  fake-cli storage smart [flags]',
    '',
    'Flags:',
    '      --disk string   磁盘设备名（必填）',
    '  -h, --help          help for smart',
    ...GLOBAL,
  ],
  file: [
    '在 NAS 上操作文件。',
    '',
    'Usage:',
    '  fake-cli file [command]',
    '',
    'Available Commands:',
    '  ls          列出目录',
    '  rm          删除文件',
    '  mkdir       建目录',
    '',
    'Flags:',
    '  -h, --help   help for file',
    ...GLOBAL,
  ],
  'file ls': [
    '列出某个目录下的文件。',
    '',
    'Usage:',
    '  fake-cli file ls [PATH...] [flags]',
    '',
    'Flags:',
    '      --all            包含隐藏文件',
    '      --path string    目录路径 (default "/")',
    '  -h, --help           help for ls',
    ...GLOBAL,
  ],
  'file rm': [
    '删除文件。',
    '',
    'Usage:',
    '  fake-cli file rm [PATH...] [flags]',
    '',
    'Flags:',
    '      --force          不询问直接删',
    '      --path string    文件路径',
    '  -h, --help           help for rm',
    ...GLOBAL,
  ],
  'file mkdir': [
    '新建目录。',
    '',
    'Usage:',
    '  fake-cli file mkdir [PATH...] [flags]',
    '',
    'Flags:',
    '      --mode string    权限（八进制）',
    '      --path string    目录路径',
    '  -h, --help           help for mkdir',
    ...GLOBAL,
  ],
  system: [
    '查看系统信息。',
    '',
    'Usage:',
    '  fake-cli system [command]',
    '',
    'Available Commands:',
    '  info        系统概况',
    '',
    'Flags:',
    '  -h, --help   help for system',
    ...GLOBAL,
  ],
  'system info': [
    '系统概况：型号、版本、运行时长。',
    '',
    'Usage:',
    '  fake-cli system info [flags]',
    '',
    'Flags:',
    '  -h, --help   help for info',
    ...GLOBAL,
  ],
};

const cmdPath = argv.filter((a) => !a.startsWith('-') && !['json'].includes(a)).slice(0, 2).join(' ').trim();
const key = cmdPath.split(' ').slice(0, 2).join(' ');

if (wantsHelp) {
  const body = HELP[key] || HELP[''];
  process.stdout.write(`${body.join('\n')}\n`);
  process.exit(0);
}

if (raw.includes('--version')) {
  process.stdout.write('fake-cli version 1.2.3\n');
  process.exit(0);
}

const out = (o) => {
  process.stdout.write(JSON.stringify(o));
  process.exit(0);
};
const boom = (msg) => {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
};

if (key === 'storage ls') {
  // 四层嵌套 + success:true，正是绿联那类工具的形状
  out({
    success: true,
    data: { data: { pool_list: { pools: [
      { id: 'pool-1', name: '存储池 1', level: 'RAID5', total: 12000, used: 4200 },
      { id: 'pool-2', name: '存储池 2', level: 'Single', total: 2000, used: 90 },
    ] } } },
  });
}

if (key === 'storage smart') {
  const disk = fromArgv('disk');
  if (!disk) boom('required flag(s) "disk" not set');
  out({ success: true, data: { disk, temperature: 38, health: 'PASSED', hours: 1200 } });
}

if (key === 'file ls') {
  const p = fromArgv('path') || '/';
  out({
    success: true,
    data: { data: { file_list: { files: [
      { name: '照片', is_dir: true, size: 0 },
      { name: '备份.tar', is_dir: false, size: 1048576 },
    ] } } },
    echo: { path: p },
  });
}

if (key === 'file rm') {
  // 业务失败但退出码 0：很多 CLI 就这么干，网关必须认 success:false
  out({ success: false, error: { message: 'permission denied: /root' } });
}

if (key === 'file mkdir') {
  out({ success: true, data: { created: fromArgv('path') } });
}

if (key === 'system info') {
  out({ success: true, data: { model: 'FakeNAS-9000', version: '1.2.3' } });
}

boom(`unknown command "${raw[0] || ''}" for "fake-cli"`);
