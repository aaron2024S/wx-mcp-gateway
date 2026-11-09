// 调用日志：一条记录怎么落盘。
//
// 这个文件只做「形状统一」，不判断任何业务。之所以从 server.js 拆出来，
// 是因为日志字段现在被三处共同依赖：写盘、控制台表格、测试断言。
// 拆开之后加字段只改一处，不会出现「后端写了、前端没读」这种半截改动。
//
// via 的含义（用户最关心的那列）：
//   llm    —— 这句话是 AI 认出来的，会带 provider / model / token 用量
//   local  —— 本地索引命中，零成本、零请求
//   ref    —— 用户回了个序号（「1」），引用上一轮列表
//   其他    —— 菜单里手选、控制台手动执行，没有识别环节
//
// token 只在 via=llm 时有意义。用量的字段名各家不一样（OpenAI 系是
// prompt/completion，Anthropic 是 input/output），在 llm.js 已统一成
// {input, output, total}，这里只负责落盘。

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 把「一句话怎么被认出来的 + 花了多少 token」压成日志字段。
 * 记录保持在 1KB 以内（log_keep 默认只留 200 条，没必要存大对象）。
 */
export function formatCall(rec) {
  const u = rec.usage || null;
  const tokIn = num(u?.input);
  const tokOut = num(u?.output);
  const tok = num(u?.total) ?? (tokIn !== null && tokOut !== null ? tokIn + tokOut : null);

  return {
    t: new Date(rec.at || Date.now()).toISOString(),
    trigger: rec.trigger || 'wechat',
    app: rec.tool?.appLabel || rec.app || '',
    appId: rec.tool?.appId || '',
    tool: rec.tool?.name || rec.tool || '',
    key: rec.tool?.key || '',
    args: rec.args || {},
    risk: rec.tool?.risk || null,
    ok: rec.ok !== false,
    ms: rec.ms || 0,
    err: rec.err || null,
    via: rec.via || null,
    // via=llm 才有；local 记录里保持 null，前端据此显示「—」而不是 0
    provider: rec.provider || null,
    model: rec.model || null,
    tokIn,
    tokOut,
    tok,
  };
}
