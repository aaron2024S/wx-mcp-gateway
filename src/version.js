// 版本号的唯一出处就是 package.json。
//
// 以前这个号在三处各写一遍（server 的 VERSION 常量、iLink 的 User-Agent、
// 页面底部的默认文案），bump 时漏一个的症状特别隐蔽：镜像 tag 已经是新的，
// 界面和 UA 还写着旧号，排查时会被带偏。现在都从这里取。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

export const VERSION = pkg.version;
