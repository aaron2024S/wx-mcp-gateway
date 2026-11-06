// 最小 MCP 客户端：Streamable HTTP + JSON-RPC 2.0，纯标准库，不引 @modelcontextprotocol/sdk。
//
// 为什么要自己写而不引 SDK：
//   1) 网关只需要 tools/list 和 tools/call 两个方法，SDK 带进来的是整套 server/client/oauth；
//   2) 镜像想保持几十 MB；
//   3) 出错时要能一眼看到是哪一层坏的（SDK 的报错经常只剩一句 "fetch failed"）。
//
// 实测踩过的三个坑，都在下面代码里处理了：
//   ① Accept 必须同时含 application/json 和 text/event-stream，不然对端（MCP SDK 实现）直接 406；
//   ② 无状态服务端不返回 Mcp-Session-Id，后续请求也不能自己编一个；
//   ③ 协议版本必须按服务端返回的走，不能认死自己发出去的那个。

const CLIENT_INFO = { name: 'wx-mcp-gateway', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

export class McpError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;      // dns | refused | timeout | auth | path | accept | protocol | server | http | parse
    this.detail = detail;
  }
}

// 把 fetch 抛出来的原始异常翻译成能给人看的分类
function classifyFetchError(e, url) {
  if (e?.name === 'AbortError') return new McpError('timeout', '连接超时', { url });
  const code = e?.cause?.code || e?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new McpError('dns', '域名解析失败', { url, code });
  }
  if (code === 'ECONNREFUSED') return new McpError('refused', '连接被拒绝（端口没开或服务没起）', { url, code });
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return new McpError('refused', '连接被重置', { url, code });
  if (String(e?.message || '').includes('certificate')) {
    return new McpError('tls', '证书校验失败', { url, message: e.message });
  }
  return new McpError('network', '网络请求失败', { url, message: e?.message, code });
}

// 响应体可能是 JSON，也可能是 SSE 流（对端 enableJsonResponse=false 时）
async function readRpcPayload(res) {
  const ctype = String(res.headers.get('content-type') || '');
  if (!ctype.includes('text/event-stream')) {
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch { throw new McpError('parse', '对端返回的不是 JSON', { sample: txt.slice(0, 200), ctype }); }
  }
  // SSE：按空行切事件，每个事件里拼 data: 行，取最后一个带 result/error 的
  const txt = await res.text();
  const events = txt.split(/\r?\n\r?\n/);
  let last = null;
  for (const ev of events) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) continue;
    try {
      const obj = JSON.parse(data);
      if (obj && (obj.result !== undefined || obj.error !== undefined)) last = obj;
    } catch { /* 心跳或注释行，跳过 */ }
  }
  if (!last) throw new McpError('parse', 'SSE 流里没有找到 JSON-RPC 响应', { sample: txt.slice(0, 200) });
  return last;
}

export class McpClient {
  constructor({ url, token, timeout = 20000, headers = {}, id = '' }) {
    this.url = url;
    this.id = id;
    this.token = token || '';
    this.timeout = timeout;
    this.extraHeaders = headers;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.instructions = '';
    this._seq = 0;
  }

  get headers() {
    const h = {
      'Content-Type': 'application/json',
      // 坑①：少了 text/event-stream 会被判 406
      Accept: 'application/json, text/event-stream',
      ...this.extraHeaders,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    // 规范要求：初始化之后每个请求都带上协商出来的版本
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  async _post(body, { timeout } = {}) {
    const ctrl = new AbortController();
    const ms = (timeout ?? this.timeout);
    const timer = setTimeout(() => ctrl.abort(), ms);
    let res;
    const started = Date.now();
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw classifyFetchError(e, this.url);
    } finally {
      clearTimeout(timer);
    }
    const ms_used = Date.now() - started;

    if (!res.ok) {
      let sample = '';
      try { sample = (await res.text()).slice(0, 300); } catch { /* 忽略 */ }
      const map = {
        401: ['auth', '鉴权失败（令牌无效或过期）'],
        403: ['auth', '被拒绝访问'],
        404: ['path', '路径不存在（检查 /mcp 是否正确）'],
        405: ['path', '方法不被允许（该端点只接受 POST）'],
        406: ['accept', '对端要求 Accept 同时包含 application/json 和 text/event-stream'],
        429: ['rate', '请求过于频繁'],
      };
      const [kind, msg] = map[res.status] || ['http', `HTTP ${res.status}`];
      throw new McpError(kind, msg, { status: res.status, sample });
    }

    const payload = await readRpcPayload(res);
    return { payload, ms: ms_used };
  }

  async rpc(method, params, opts = {}) {
    const body = { jsonrpc: '2.0', method };
    if (!opts.notify) body.id = opts.id ?? ++this._seq;
    if (params !== undefined) body.params = params;

    const { payload, ms } = await this._post(body, opts);
    if (!payload) return { result: null, ms };     // 通知类请求可能没有响应体
    if (payload.error) {
      throw new McpError('server', payload.error.message || '对端返回错误', {
        code: payload.error.code, data: payload.error.data,
      });
    }
    return { result: payload.result, ms };
  }

  async initialize() {
    const { result, ms } = await this.rpc('initialize', {
      protocolVersion: DEFAULT_PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.protocolVersion = result?.protocolVersion || DEFAULT_PROTOCOL;
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || null;
    this.instructions = result?.instructions || '';
    // 握手最后一步，通知类请求，不需要响应
    try { await this.rpc('notifications/initialized', undefined, { notify: true }); } catch { /* 有的实现不回也正常 */ }
    return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo, ms };
  }

  async listTools() {
    const { result, ms } = await this.rpc('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return { tools, ms, nextCursor: result?.nextCursor || null };
  }

  async callTool(name, args = {}) {
    const { result, ms } = await this.rpc('tools/call', { name, arguments: args });
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    // 很多 server 把结构化结果再编码成 JSON 字符串塞进 text，这里帮调用方省掉一次 parse
    let data = null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { data = JSON.parse(trimmed); } catch { /* 不是 JSON 就保持纯文本 */ }
    }
    return {
      isError: result?.isError === true,
      text,
      data,
      structured: result?.structuredContent || null,
      ms,
    };
  }

  // 一次性完成：连接 + 初始化 + 拉工具，供 registry 刷新时调用
  static async probe(opts) {
    const c = new McpClient(opts);
    const init = await c.initialize();
    const list = await c.listTools();
    return { client: c, init, tools: list.tools };
  }
}
