// 微信 iLink 客户端：扫码绑定 + 长轮询收消息 + 发消息。
//
// 这套接口不是腾讯公开文档，是从「微信智能硬件 / OpenClaw」那条通道逆向出来的。
// 字段名在这里全部写死并由单测锁住，因为**它一旦变了，网关会整体失灵**，
// 而失灵的表现通常只是"消息不进来"，很难反查。所以：
//   · 所有响应里的 errcode / ret 都会检查，非 0 就记日志并抛错（不静默）；
//   · -14 单独识别为「会话作废」，直接转 needs_relogin，不做无意义重试；
//   · 游标 get_updates_buf 持久化，重启后不从零拉，避免历史消息重投。
//
// 与 Freya 那份实现的差异（有意为之）：
//   1) 它把 getUpdatesBuf 重置为空串重启 ⇒ 最近消息会重投；这里落盘。
//   2) 它不设长轮询 timeout，靠对端断开；这里设 90 秒兜底，防止连接被中间设备吊死。
//   3) 这里做消息 id 去重（同一 msg 因重试被投两次时只处理一次）。

import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readJson, writeJson } from './store.js';
import { errText } from './log.js';

const require = createRequire(import.meta.url);
const qrlib = require('../vendor/qrcode.cjs');

export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
// 这两个常量社区各版本不一致（有写 "1"、有写 base64），这里跟官方随 OpenClaw 放出的值走。
const CLIENT_VERSION = '65547';
const CHANNEL_VERSION = '2.4.9';
const BOT_AGENT = 'wx-mcp-gateway/0.3.0';

const QR_TTL_MS = 5 * 60 * 1000;
const QR_POLL_MS = 3000;
const POLL_TIMEOUT_MS = 90 * 1000;   // 服务端大约扣 35 秒，90 秒是兜底上限
const RETRY_MS = 5000;
const MAX_CHUNK = 1000;              // 单条文本上限，超长自动分片

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IlinkError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'IlinkError';
    this.kind = kind;   // network | http | protocol | auth | relogin | timeout
    this.detail = detail;
  }
}

// 把二维码链接渲染成 SVG。qrcode_img_content 是**待编码的文本**，不是图片地址，
// 这点最容易搞错——直接 <img src> 出去会得到一张坏图。
export function qrSvg(text, { scale = 6, margin = 2 } = {}) {
  const qr = qrlib(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * scale;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        d += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

// 从一条 iLink 消息里抽取纯文本。图片/语音/文件一律降级成一句人话，
// 因为网关的出口是纯文本管道，传不了媒体。
function extractText(msg) {
  const parts = [];
  for (const item of msg.item_list || []) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text);
    else if (item.type === 2) parts.push('[图片]');
    else if (item.type === 3 && item.voice_item?.text) parts.push(item.voice_item.text);
    else if (item.type === 3) parts.push('[语音]');
    else if (item.type === 4) parts.push(`[文件：${item.file_item?.file_name || '未命名'}]`);
    else if (item.type === 5) parts.push('[视频]');
  }
  return parts.join('\n').trim();
}

function chunkText(text, size = MAX_CHUNK) {
  const s = String(text ?? '');
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export class IlinkClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      会话落盘目录
   * @param {string} [opts.baseUrl]    覆盖默认接入点（测试用）
   * @param {object} opts.log          logger
   * @param {string} [opts.appId]
   */
  constructor({ dataDir, baseUrl = DEFAULT_BASE, log, appId = 'bot' }) {
    super();
    this.dataDir = dataDir;
    this.baseUrlFixed = baseUrl;
    this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
    this.appId = appId;
    this.sessionFile = path.join(dataDir, 'weixin.json');

    this.state = {
      status: 'idle',      // idle | scanning | online | offline | expired | needs_relogin
      token: '',
      baseUrl: '',
      botId: '',
      buf: '',             // get_updates_buf 游标
      boundAt: null,
      lastError: null,
      lastMsgAt: null,
      recv: 0,             // 本次运行收/发计数
      sent: 0,
    };
    this.qr = null;        // { code, url, svg, at }
    this.contextTokens = new Map();   // chatId -> context_token
    this._seen = [];       // 消息 id 去重窗口
    this._seenSet = new Set();
    this._stopped = false;
    this._loopRunning = false;
    this._qrGen = 0;       // 二维码代际：取消/重扫时让旧轮询自行退出
    this._saveTimer = null;
  }

  get online() {
    return this.state.status === 'online';
  }

  load() {
    const s = readJson(this.sessionFile, null);
    if (s?.token && s?.baseUrl) {
      this.state.token = s.token;
      this.state.baseUrl = s.baseUrl;
      this.state.botId = s.botId || '';
      this.state.buf = s.buf || '';
      this.state.boundAt = s.boundAt || null;
      this.state.status = 'offline';
      for (const [k, v] of Object.entries(s.contextTokens || {})) this.contextTokens.set(k, v);
      this.log.info('wechat', `读到已保存的绑定（bot ${this.state.botId || '未知'}），准备上线`);
      return true;
    }
    return false;
  }

  save() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.state.token) return;
    writeJson(this.sessionFile, {
      token: this.state.token,
      baseUrl: this.state.baseUrl,
      botId: this.state.botId,
      buf: this.state.buf,
      boundAt: this.state.boundAt,
      contextTokens: Object.fromEntries(this.contextTokens),
    }, { mode: 0o600 });
  }

  // 游标更新很频繁（每条消息一次），批量落盘，避免频繁写盘
  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 1500);
    this._saveTimer.unref?.();
  }

  _setStatus(status, error = null) {
    if (this.state.status === status && this.state.lastError === error) return;
    this.state.status = status;
    this.state.lastError = error;
    this.emit('state', this.statusInfo());
  }

  statusInfo() {
    return {
      status: this.state.status,
      online: this.online,
      botId: this.state.botId,
      baseUrl: this.state.baseUrl,
      boundAt: this.state.boundAt,
      lastError: this.state.lastError,
      lastMsgAt: this.state.lastMsgAt,
      recv: this.state.recv,
      sent: this.state.sent,
      bufOffset: this.state.buf ? String(this.state.buf).length : 0,
      qr: this.qr ? { url: this.qr.url, svg: this.qr.svg, at: this.qr.at, expiresAt: this.qr.at + QR_TTL_MS } : null,
    };
  }

  _headers(token) {
    const h = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      // 每次请求换一个随机值：参考实现如此，跟着做，别自己改成固定值
      'X-WECHAT-UIN': String(crypto.randomBytes(4).readUInt32BE(0)),
      'iLink-App-Id': this.appId,
      'iLink-App-ClientVersion': CLIENT_VERSION,
    };
    if (token) h.Authorization = `Bearer ${String(token).trim()}`;
    return h;
  }

  async call(endpoint, body = {}, { base, token, timeout = 20000 } = {}) {
    const root = base || this.state.baseUrl || this.baseUrlFixed;
    const url = `${String(root).replace(/\/+$/, '')}/${endpoint}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this._headers(token ?? this.state.token),
        body: JSON.stringify({
          ...body,
          base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new IlinkError('timeout', `请求超时（${endpoint}）`, { url });
      const code = e?.cause?.code || '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new IlinkError('network', '域名解析失败', { host: url });
      if (code === 'ECONNREFUSED') throw new IlinkError('network', '连接被拒绝', { url });
      throw new IlinkError('network', `网络错误：${e?.message || e}`, { url, code });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let sample = '';
      try { sample = (await res.text()).slice(0, 200); } catch { /* 忽略 */ }
      const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
      throw new IlinkError(kind, `HTTP ${res.status}（${endpoint}）`, { status: res.status, sample });
    }

    let data;
    try { data = await res.json(); }
    catch { throw new IlinkError('protocol', `返回的不是 JSON（${endpoint}）`); }

    // 所有 iLink 响应都可能带 errcode 或 ret，任一非 0 即失败
    const code = data?.errcode ?? data?.ret ?? 0;
    if (code !== 0) {
      if (code === -14) throw new IlinkError('relogin', '微信会话已失效（-14），需要重新扫码', data);
      throw new IlinkError('protocol', `接口返回错误 ${code}：${data?.errmsg || '无说明'}`, data);
    }
    return data;
  }

  // ---- 扫码绑定 -------------------------------------------------------

  async beginLogin() {
    if (this.online) return { already: true, status: this.statusInfo() };

    // 上一次的二维码还没过 4 分钟且仍在扫，直接复用，避免刷码被限
    if (this.qr && this.state.status === 'scanning' && Date.now() - this.qr.at < QR_TTL_MS - 60_000) {
      return { code: this.qr.code, url: this.qr.url, svg: this.qr.svg, at: this.qr.at };
    }

    // 解除绑定 / 会话失效都会把 _stopped 置 true，重新扫码必须复位，
    // 否则后面的扫码轮询和长轮询第一轮就退出，表现为"扫了码永远不上线"
    this._stopped = false;
    const gen = ++this._qrGen;

    const res = await this.call('ilink/bot/get_bot_qrcode?bot_type=3', {}, {
      base: this.baseUrlFixed,
      token: '', // 拿码不需要 token
      timeout: 15000,
    });
    if (!res.qrcode) throw new IlinkError('protocol', '服务端没有返回二维码标识');

    const url = res.qrcode_img_content || '';
    const qrObj = {
      code: res.qrcode,
      url,
      svg: url ? qrSvg(url) : '',
      at: Date.now(),
    };
    this.qr = qrObj;
    this._setStatus('scanning');
    this.log.info('wechat', '已生成登录二维码，等待扫码（5 分钟内有效）');

    // 后台轮询，不阻塞 HTTP 请求——前端靠 /api/wechat/status 看进度
    // 返回值和轮询都用 qrObj 这个局部引用：轮询可能同步就把 this.qr 置空（超时/取消）
    this._pollScan(qrObj.code, gen).catch((e) => {
      if (this._qrGen !== gen) return;   // 旧代际的异常不打扰新流程
      this.log.error('wechat', `扫码轮询异常：${errText(e)}`);
      this._setStatus('offline', errText(e));
    });

    return { ...qrObj };
  }

  async _pollScan(code, gen) {
    const until = Date.now() + QR_TTL_MS;
    while (!this._stopped && this._qrGen === gen && Date.now() < until) {
      if (this.state.status !== 'scanning') return;   // 用户取消了/已被别的流程改状态
      let r;
      try {
        r = await this.call(
          `ilink/bot/get_qrcode_status?bot_type=3&qrcode=${encodeURIComponent(code)}`,
          {},
          { base: this.baseUrlFixed, token: '', timeout: 15000 },
        );
      } catch (e) {
        // 单次查询失败不等于过期，等一下再试
        this.log.warn('wechat', `查询扫码状态失败：${errText(e)}`);
        await sleep(RETRY_MS);
        continue;
      }

      if (r.status === 'confirmed' && r.bot_token) {
        if (this._qrGen !== gen) return;   // 已经被新一轮扫码取代，这个 token 作废
        this.state.token = r.bot_token;
        this.state.baseUrl = r.baseurl || this.baseUrlFixed;
        this.state.botId = r.ilink_bot_id || 'bot';
        this.state.boundAt = new Date().toISOString();
        this.state.buf = '';
        this.qr = null;
        this.save();
        this.log.info('wechat', `绑定成功：bot ${this.state.botId}，接入点 ${this.state.baseUrl}`);
        await this.start();
        return;
      }
      if (r.status === 'expired') {
        if (this._qrGen !== gen) return;
        this.qr = null;
        this._setStatus('expired', '二维码已过期，请重新生成');
        this.log.warn('wechat', '二维码已过期');
        return;
      }
      // wait / scanned：继续等。刻意不缩短间隔——频繁查询会被风控。
      await sleep(QR_POLL_MS);
    }
    if (this._qrGen === gen && this.state.status === 'scanning') {
      this.qr = null;
      this._setStatus('expired', '二维码超时未扫码，请重新生成');
    }
  }

  cancelLogin() {
    if (this.state.status === 'scanning') {
      this.qr = null;
      this._stopped = true;
      this._qrGen++;
      this._setStatus('idle');
    }
  }

  // ---- 上线 / 长轮询 --------------------------------------------------

  async start() {
    if (!this.state.token) {
      this._setStatus('needs_relogin', '没有绑定信息，请扫码');
      return false;
    }
    this._stopped = false;
    try {
      await this.call('ilink/bot/msg/notifystart', {}, { timeout: 15000 });
    } catch (e) {
      if (e.kind === 'relogin') { this._invalidate(errText(e)); return false; }
      // 上线通知失败不致命：长轮询本身仍可能成功
      this.log.warn('wechat', `上线通知失败（继续尝试收消息）：${errText(e)}`);
    }
    this._setStatus('online');
    this._startLoop();
    return true;
  }

  _startLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._loop().catch((e) => {
      this._loopRunning = false;
      this.log.error('wechat', `长轮询意外退出：${errText(e)}`);
    });
  }

  async _loop() {
    while (!this._stopped) {
      if (this.state.status !== 'online') break;
      let r;
      try {
        r = await this.call('ilink/bot/getupdates', { get_updates_buf: this.state.buf }, {
          timeout: POLL_TIMEOUT_MS,
        });
      } catch (e) {
        if (this._stopped) break;
        if (e.kind === 'relogin') { this._invalidate(errText(e)); break; }
        // 长轮询正常就会周期性"超时"（服务端扣住连接），不该当成故障刷屏
        if (e.kind !== 'timeout') this.log.warn('wechat', `收消息失败，${RETRY_MS / 1000}s 后重试：${errText(e)}`);
        await sleep(RETRY_MS);
        continue;
      }

      const nextBuf = r.get_updates_buf;
      if (typeof nextBuf === 'string' && nextBuf !== this.state.buf) {
        this.state.buf = nextBuf;
        this._saveSoon();
      }

      const msgs = Array.isArray(r.msgs) ? r.msgs : [];
      for (const m of msgs) this._handleIncoming(m);

      // 成功立即续杯，绝不加 sleep：加一点延迟就变成"每秒轮询"，明显更容易被限流
    }
    this._loopRunning = false;
    // 解绑后几秒内重新扫码时，旧循环可能还挂在一次长轮询上；
    // 它退出时若已经重新上线，就把循环接上，否则表现为"显示在线但收不到消息"
    if (!this._stopped && this.state.status === 'online') this._startLoop();
  }

  _handleIncoming(m) {
    const from = m.from_user_id;
    if (!from) return;

    const text = extractText(m);
    const id = m.msg_id || m.msgid || m.id
      || crypto.createHash('sha1').update(`${from}|${m.context_token || ''}|${m.create_time || ''}|${text}`).digest('hex').slice(0, 16);

    if (this._seenSet.has(id)) return;   // 重投去重
    this._seenSet.add(id);
    this._seen.push(id);
    if (this._seen.length > 300) this._seenSet.delete(this._seen.shift());

    if (m.context_token) {
      this.contextTokens.set(from, m.context_token);
      this._saveSoon();
    }
    this.state.recv += 1;
    this.state.lastMsgAt = new Date().toISOString();

    if (!text) {
      this.log.debug('wechat', `收到非文本消息（from ${from}），已忽略`);
      return;
    }
    this.log.info('wechat', `收到消息 from=${from}: ${text.slice(0, 60)}`);
    this.emit('message', {
      chatId: from,
      text,
      contextToken: m.context_token || '',
      at: Date.now(),
    });
  }

  async send(chatId, text, contextToken) {
    if (!this.online) {
      this.log.warn('wechat', '未上线，消息发不出去');
      return { ok: false, error: '微信未上线' };
    }
    const ctx = contextToken || this.contextTokens.get(chatId) || '';
    const chunks = chunkText(text);
    for (const [i, chunk] of chunks.entries()) {
      try {
        await this.call('ilink/bot/sendmessage', {
          msg: {
            from_user_id: '',
            to_user_id: chatId,
            client_id: `wxgw-${crypto.randomUUID()}`,
            message_type: 2,
            message_state: 2,
            context_token: ctx,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
        }, { timeout: 20000 });
      } catch (e) {
        if (e.kind === 'relogin') this._invalidate(errText(e));
        this.log.error('wechat', `发送失败（第 ${i + 1}/${chunks.length} 片）：${errText(e)}`);
        return { ok: false, error: errText(e) };
      }
    }
    this.state.sent += chunks.length;
    return { ok: true, chunks: chunks.length };
  }

  _invalidate(reason) {
    this.log.error('wechat', `会话失效：${reason}`);
    this._stopped = true;
    this.state.token = '';
    this.state.baseUrl = '';
    this.state.buf = '';
    this.qr = null;
    // 清掉落盘凭据，避免重启后拿一个作废的 token 反复失败
    try { writeJson(this.sessionFile, {}, { mode: 0o600 }); } catch { /* 忽略 */ }
    this._setStatus('needs_relogin', '会话已失效，请重新扫码绑定');
  }

  async stop() {
    this._stopped = true;
    if (this.state.token && this.online) {
      await this.call('ilink/bot/msg/notifystop', {}, { timeout: 8000 }).catch(() => {});
    }
    this.save();
    this._setStatus('offline');
  }

  async logout() {
    this._stopped = true;
    this._qrGen++;                    // 让还在等待的扫码轮询自己退出
    if (this.state.token) {
      await this.call('ilink/bot/msg/notifystop', {}, { timeout: 8000 }).catch(() => {});
    }
    this.state.token = '';
    this.state.baseUrl = '';
    this.state.buf = '';
    this.state.botId = '';
    this.state.boundAt = null;
    this.contextTokens.clear();
    try { writeJson(this.sessionFile, {}, { mode: 0o600 }); } catch { /* 忽略 */ }
    this._setStatus('idle');
    this.log.info('wechat', '已解除绑定');
  }
}
