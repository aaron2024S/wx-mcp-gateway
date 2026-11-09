// 控制台前端：零依赖，一个文件。
// 刻意不上 Vue/React——这个界面没有复杂状态，多一层构建只会多一处坏的地方。

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let S = {
  data: null,
  page: location.hash.slice(1) || 'overview',
  logs: { rows: [], total: 0, offset: 0, limit: 20 },
  qrSig: '',
  timer: null,
};

// ---- 请求 -------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  // 会话过期（或密码被改过）时服务端一律 401，直接甩回登录页。
  // 不在这里弹"请重新登录"的框：密码改过之后任何操作都必然 401，
  // 让用户对着一个只能点确定的弹窗，不如把页面换成登录页。
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('登录已失效');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('on'), 2400);
}

// ---- 主题：跟随系统 / 浅色 / 深色 --------------------------------------

const THEME_KEY = 'gw_theme_mode';
const THEME_MODES = ['auto', 'light', 'dark'];
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = 'auto';

function resolveTheme(mode) {
  return mode === 'auto' ? (mqDark.matches ? 'dark' : 'light') : mode;
}

function paintTheme() {
  document.documentElement.dataset.theme = resolveTheme(themeMode);
  document.documentElement.dataset.themeMode = themeMode;
  $$('.seg-btn[data-theme-mode]').forEach((b) => {
    const on = b.dataset.themeMode === themeMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setThemeMode(mode) {
  themeMode = THEME_MODES.includes(mode) ? mode : 'auto';
  try {
    localStorage.setItem(THEME_KEY, themeMode);
    localStorage.removeItem('gw_theme'); // 旧版只存过一次 light/dark，迁移完就清掉
  } catch (e) { /* 隐私模式下忽略 */ }
  paintTheme();
}

// 老用户身上只有 gw_theme，按它推断一次，之后统一用 gw_theme_mode
setThemeMode(localStorage.getItem(THEME_KEY) || localStorage.getItem('gw_theme') || 'auto');
$$('.seg-btn[data-theme-mode]').forEach((b) => {
  b.onclick = () => setThemeMode(b.dataset.themeMode);
});

// 跟随系统时，系统在明暗之间切换要实时跟过去（不用刷新）
const onSystemThemeChange = () => { if (themeMode === 'auto') paintTheme(); };
if (mqDark.addEventListener) mqDark.addEventListener('change', onSystemThemeChange);
else if (mqDark.addListener) mqDark.addListener(onSystemThemeChange); // 老内核

$('#logoutBtn').onclick = doLogout;

// ---- 导航 -------------------------------------------------------------

const TITLES = {
  overview: ['概览', '最近 24 小时'],
  apps: ['应用', '接入的 MCP server'],
  tools: ['工具', '由各应用自动发现'],
  logs: ['调用日志', '全部记录'],
  settings: ['设置', '微信通道 · 行为 · AI'],
};

function go(page) {
  S.page = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  const [t, s] = TITLES[page] || ['', ''];
  $('#pageTitle').textContent = t;
  $('#pageSub').textContent = s;
  history.replaceState(null, '', '#' + page);
  if (page === 'logs') loadLogs(0);
}
$$('.nav-item').forEach((b) => { b.onclick = () => go(b.dataset.page); });
$$('[data-goto]').forEach((b) => { b.onclick = () => go(b.dataset.goto); });

// ---- 概览 -------------------------------------------------------------

const RISK = { read: '只读', write: '写入', high: '高危' };
const RISK_CLS = { read: 'read', write: 'write', high: 'high' };

function appCard(a) {
  const on = a.status === 'online';
  const enabled = (a.tools?.include?.length) ? a.tools.include.length : a.toolCount;
  const total = a.toolCount;
  return `<div class="card app-card" data-app="${esc(a.id)}">
    <div class="app-head">
      <span class="dot ${on ? '' : 'off'}"></span>
      <span class="app-name">${esc(a.label)}</span>
      <span class="more">${on ? total + ' 个工具' : '离线'}</span>
    </div>
    ${a.aliases?.length ? `<p class="app-alias">${esc(a.aliases.join(' · '))}</p>` : ''}
    <div><span class="mono">${esc(a.url || '')}</span></div>
    ${on ? '' : `<div class="hint" style="color:var(--red)">${esc(a.error?.message || '连不上')}</div>`}
    <div class="app-meta">
      <span>${enabled}/${total} 工具启用</span>
      <span class="sep"></span>
      <span>${(a.allow_risk || []).map((r) => RISK[r]).join('/')}</span>
      ${a.source === 'config' ? '<span class="sep"></span><span>来自配置文件</span>' : ''}
    </div>
  </div>`;
}

function logTable(rows, compact) {
  if (!rows.length) return '<div class="empty">还没有调用记录</div>';
  const head = `<thead><tr><th style="width:78px">时间</th><th style="width:66px">触发</th>
    <th style="width:70px">应用</th><th>工具</th><th style="width:88px">结果</th>
    <th style="width:64px">耗时</th></tr></thead>`;
  const body = rows.map((r) => {
    const t = String(r.t || '').slice(11, 19);
    const ok = r.ok ? '<span class="ok">成功</span>'
      : `<span class="err" title="${esc(r.err || '')}">失败</span>`;
    return `<tr><td>${t}</td><td>${esc(TRIGGER[r.trigger] || r.trigger || '')}</td>
      <td class="strong">${esc(r.app || '')}</td>
      <td><span class="mono">${esc(r.tool || '')}</span></td>
      <td>${ok}</td><td>${r.ms || 0} ms</td></tr>`;
  }).join('');
  return `<table>${compact ? '' : head}<tbody>${body}</tbody></table>`;
}

const TRIGGER = { wechat: '微信', console: '控制台', system: '系统' };

function renderOverview() {
  const d = S.data;
  if (!d) return;
  const wx = d.wechat;
  $('#mWx').innerHTML = wx.online ? '在线' : '<span style="color:var(--text-faint)">未在线</span>';
  $('#mApps').innerHTML = `${d.apps.filter((a) => a.status === 'online').length}<small>/ ${d.apps.length}</small>`;
  $('#mTools').textContent = d.toolCount;
  $('#mCalls').innerHTML = `${d.stats.todayCalls}${d.stats.todayFail
    ? `<small style="color:var(--red)">失败 ${d.stats.todayFail}</small>` : ''}`;

  $('#overviewApps').innerHTML = d.apps.length
    ? d.apps.map(appCard).join('')
    : '<div class="empty" style="grid-column:1/-1">还没有接入应用。去「应用」页添加一个。</div>';
  bindCards();

  $('#recentTable').innerHTML = logTable((d.recent || []).slice(0, 5), false);
}

function bindCards() {
  $$('.app-card').forEach((c) => {
    c.onclick = () => editApp(c.dataset.app);
  });
}

// ---- 应用 -------------------------------------------------------------

function renderApps() {
  const d = S.data;
  if (!d) return;
  // 出厂不带任何应用，所以第一次进来大概率是空的——给一句话说清下一步，
  // 否则页面上只有一个虚线框，容易以为是加载失败。
  const cards = d.apps.length
    ? d.apps.map(appCard).join('')
    : `<div class="empty" style="grid-column:1/-1">
         还没有接入应用。点下面的卡片加一个——填上它的 MCP 端点地址（形如 <code>http://服务名:端口/mcp</code>）即可。
       </div>`;
  const add = `<button class="card app-card" id="addCard" style="border-style:dashed; align-items:center; justify-content:center; min-height:132px; color:var(--text-faint)">
     + 添加应用</button>`;
  $('#appGrid').innerHTML = cards + add;
  bindCards();
  const b = $('#addCard');
  if (b) b.onclick = () => openWizard(null);
}

// ---- 工具 -------------------------------------------------------------

function renderTools() {
  const d = S.data;
  if (!d) return;
  if (!d.tools.length) {
    $('#toolGroups').innerHTML = '<div class="empty">还没有工具——先接入一个应用。</div>';
    return;
  }
  const groups = {};
  for (const t of d.tools) (groups[t.appId] ||= { label: t.appLabel, items: [] }).items.push(t);

  $('#toolGroups').innerHTML = Object.entries(groups).map(([id, g]) => `
    <div class="section-title" style="margin-top:18px">${esc(g.label)}<span class="line"></span>
      <span style="font-size:11.5px; color:var(--text-faint)">${g.items.length} 个</span></div>
    ${g.items.map((t) => `
      <div class="tool-line" data-key="${esc(t.key)}">
        <div style="flex:1; min-width:0">
          <div class="n">${esc(t.name)}</div>
          <div class="d">${esc(t.title || '')}${t.title ? ' · ' : ''}${esc((t.description || '').slice(0, 90))}</div>
        </div>
        <span class="sp"></span>
        <span class="badge ${RISK_CLS[t.risk]}">${RISK[t.risk]}</span>
      </div>`).join('')}
  `).join('');

  $$('#toolGroups .tool-line').forEach((row) => {
    row.onclick = () => openRunner(row.dataset.key);
  });
}

// ---- 日志 -------------------------------------------------------------

async function loadLogs(offset) {
  const limit = 20;
  const r = await api(`/api/logs?offset=${offset}&limit=${limit}`);
  S.logs = { ...r, limit };
  renderLogs();
  return r;
}

function renderLogs() {
  const { rows, total, offset, limit } = S.logs;
  $('#logTable').innerHTML = logTable(rows, false);
  const pages = Math.max(1, Math.ceil(total / limit));
  const cur = Math.floor(offset / limit) + 1;

  const btn = (label, page, dis, active) =>
    `<button ${dis ? 'disabled' : ''} class="${active ? 'on' : ''}" data-pg="${page}">${label}</button>`;

  const nums = [];
  if (pages <= 7) for (let i = 1; i <= pages; i++) nums.push(i);
  else {
    nums.push(1);
    if (cur > 3) nums.push('...');
    for (let i = Math.max(2, cur - 1); i <= Math.min(pages - 1, cur + 1); i++) nums.push(i);
    if (cur < pages - 2) nums.push('...');
    nums.push(pages);
  }

  $('#logPager').innerHTML =
    btn('上一页', cur - 1, cur === 1) +
    nums.map((n) => (n === '...'
      ? '<span style="color:var(--text-faint); padding:0 4px">…</span>'
      : btn(n, n, false, n === cur))).join('') +
    btn('下一页', cur + 1, cur === pages) +
    `<span class="info">共 ${total} 条 · 第 ${cur} / ${pages} 页</span>`;

  $$('#logPager button').forEach((b) => {
    b.onclick = () => {
      const p = Number(b.dataset.pg);
      if (p >= 1 && p <= pages) loadLogs((p - 1) * limit);
    };
  });
}

// ---- 设置：微信 -------------------------------------------------------

function renderWxCard() {
  const wx = S.data?.wechat;
  if (!wx) return;
  const box = $('#wxCard');

  // 扫码中：显示二维码，且只在内容变化时重绘（否则轮询会让二维码一直闪）
  if (wx.status === 'scanning' && wx.qr) {
    const sig = String(wx.qr.at);
    if (S.qrSig !== sig) {
      S.qrSig = sig;
      box.innerHTML = `<div style="display:flex; gap:26px; align-items:flex-start">
        <div>
          <div class="qr-box" id="qrBox" style="flex:0 0 200px; width:200px; height:200px; padding:10px"></div>
          <p style="font-size:11.5px; color:var(--text-faint); margin:10px 0 0; text-align:center">5 分钟内有效</p>
        </div>
        <div style="flex:1">
          <div style="display:flex; align-items:center; gap:9px; margin-bottom:14px">
            <span class="dot warn"></span><span style="font-size:14px; font-weight:500">等待扫码</span>
          </div>
          <p style="font-size:12.5px; color:var(--text-dim); line-height:1.7; margin:0 0 14px">
            用手机微信扫左边的码，确认后网关会自动上线。<br>
            扫完不需要回来点任何按钮。
          </p>
          <div style="padding:11px 13px; background:var(--amber-soft); border-radius:9px; font-size:11.5px; color:var(--amber); line-height:1.6">
            二维码过期后不会自动重试（防刷号）。过期了点「重新生成」。
          </div>
          <div style="margin-top:16px"><button class="btn ghost" id="wxCancel">取消</button></div>
        </div>
      </div>`;
      const q = $('#qrBox');
      if (q && wx.qr.svg) q.innerHTML = wx.qr.svg;
      const c = $('#wxCancel');
      if (c) c.onclick = () => api('/api/wechat/logout', { method: 'POST' }).then(() => { toast('已取消扫码'); refreshAll(); });
    }
    return;
  }

  S.qrSig = '';

  if (wx.status === 'online') {
    box.innerHTML = `<div class="kv" style="grid-template-columns:110px 1fr 110px 1fr; gap:11px 18px">
      <span class="k">状态</span><span class="v" style="display:flex; align-items:center; gap:7px"><span class="dot"></span>在线</span>
      <span class="k">机器人 ID</span><span class="v mono">${esc(wx.botId || '—')}</span>
      <span class="k">接入点</span><span class="v mono">${esc(wx.baseUrl || '—')}</span>
      <span class="k">绑定时间</span><span class="v">${esc((wx.boundAt || '').replace('T', ' ').slice(0, 16) || '—')}</span>
      <span class="k">今日收发</span><span class="v">收 ${wx.recv} · 发 ${wx.sent}</span>
      <span class="k">最近消息</span><span class="v">${esc((wx.lastMsgAt || '').replace('T', ' ').slice(0, 19) || '—')}</span>
    </div>
    <div style="margin-top:18px; display:flex; gap:10px">
      <button class="btn" id="wxPush">推一条测试消息</button>
      <button class="btn ghost" id="wxRelogin">重新扫码</button>
      <button class="btn ghost" id="wxLogout">解除绑定</button>
    </div>
    <div style="margin-top:16px; padding:11px 13px; background:var(--amber-soft); border-radius:9px; font-size:11.5px; color:var(--amber); line-height:1.6">
      会话失效（返回 -14）时只有人工重扫能恢复，所以「重新扫码」不会藏起来。
    </div>`;
    $('#wxPush').onclick = async () => {
      try {
        await api('/api/wechat/push', { method: 'POST', body: { text: '这是一条来自网关的测试消息。' } });
        toast('已推送，去微信看看');
      } catch (e) { toast(e.message); }
    };
    $('#wxRelogin').onclick = async () => {
      if (!confirm('重新扫码会先解绑当前机器人，期间的微信指令会失效。继续？')) return;
      try { await api('/api/wechat/relogin', { method: 'POST' }); toast('已解绑，用新码重新扫一次'); refreshAll(); }
      catch (e) { toast(e.message); }
    };
    $('#wxLogout').onclick = async () => {
      if (!confirm('解除绑定后需要重新扫码才能再控制微信。\n\n已接入的应用、工具勾选和 AI 配置都会保留，只切断微信这条入口。继续？')) return;
      try {
        await api('/api/wechat/logout', { method: 'POST' });
        toast('已解除绑定，微信指令已失效');
        refreshAll();
      } catch (e) { toast(e.message); }
    };
    return;
  }

  // 未绑定 / 已过期 / 需要重扫
  const map = {
    needs_relogin: ['会话已失效', '需要重新扫码绑定', 'warn'],
    expired: ['二维码已过期', '点下面的按钮重新生成', 'warn'],
    offline: ['未上线', '网关会自己重试；一直不上来就重新扫码', 'warn'],
  };
  const [title, desc, dot] = map[wx.status] || ['未绑定', '扫码后就能用微信控制所有应用', 'off'];
  box.innerHTML = `<div style="display:flex; gap:26px; align-items:flex-start">
    <div style="flex:0 0 200px; width:200px; height:200px; border:1px dashed var(--border); border-radius:12px; display:flex; align-items:center; justify-content:center; color:var(--text-faint); font-size:12px">
      未绑定
    </div>
    <div style="flex:1">
      <div style="display:flex; align-items:center; gap:9px; margin-bottom:14px">
        <span class="dot ${dot}"></span><span style="font-size:14px; font-weight:500">${title}</span>
      </div>
      <p style="font-size:12.5px; color:var(--text-dim); line-height:1.7; margin:0 0 16px">${esc(desc)}</p>
      ${wx.lastError ? `<div class="hint" style="color:var(--red); margin-bottom:12px">${esc(wx.lastError)}</div>` : ''}
      <button class="btn primary" id="wxBind">生成二维码</button>
      <div style="margin-top:18px; padding:11px 13px; background:var(--surface-2); border-radius:9px; font-size:11.5px; color:var(--text-faint); line-height:1.6">
        扫码授权的是「机器人」这个身份，不是你的微信号，也不需要密码。<br>
        整个链路只有出站请求，不需要公网 IP、端口映射或内网穿透。
      </div>
    </div>
  </div>`;
  $('#wxBind').onclick = async () => {
    const b = $('#wxBind');
    b.disabled = true;
    b.textContent = '生成中…';
    try {
      await api('/api/wechat/qr', { method: 'POST' });
      S.qrSig = '';
      await refreshAll();
    } catch (e) {
      toast(e.message);
      b.disabled = false;
      b.textContent = '生成二维码';
    }
  };
}

// ---- 设置：表单 -------------------------------------------------------

function fillSettings() {
  const s = S.data?.settings;
  if (!s) return;
  $('#setConfirmTtl').value = s.confirm_ttl;
  $('#setCallTimeout').value = s.call_timeout;
  $('#setAsyncAfter').value = s.async_after;
  $('#setLogKeep').value = s.log_keep;
  $('#setConfirmRisk').value = (s.confirm_risk || []).join(',');
  $('#setLlmEnabled').checked = s.llm_enabled === true;
  $('#setLlmWhen').value = s.llm_when || 'miss';

  const apps = S.data.apps;
  $('#setDefaultApp').innerHTML = '<option value="">（不指定）</option>'
    + apps.map((a) => `<option value="${esc(a.id)}" ${s.default_app === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('');

  loadProviders();
}

async function loadProviders() {
  try {
    const r = await api('/api/providers');
    const list = Object.values(r.providers || {});
    $('#setLlmDefault').innerHTML = '<option value="">（未选择）</option>'
      + list.map((p) => `<option value="${esc(p.id)}" ${r.settings.llm_default === p.id ? 'selected' : ''}>${esc(p.label)} · ${esc(p.model)}</option>`).join('');

    $('#provList').innerHTML = list.length ? list.map((p) => `
      <div class="tool-line" style="cursor:default">
        <div style="flex:1; min-width:0">
          <div class="n">${esc(p.id)} <span class="badge ghost">${esc(p.type)}</span></div>
          <div class="d">${esc(p.base_url)} · ${esc(p.model)} · ${p.hasKey ? '已设置密钥' : '无密钥'}</div>
        </div>
        <span class="sp"></span>
        ${p.source === 'config' ? '<span class="badge ghost" title="来自 config.json，要在界面删就先把它从文件里去掉">配置文件</span>' : `<button class="btn sm ghost" data-del-prov="${esc(p.id)}">删除</button>`}
      </div>`).join('') : '<div class="hint">还没有服务商。点右上角「添加服务商」，把厂商给的接口地址和模型名填进去就行——任何 OpenAI 兼容的服务都能用，不限于预设列表。不配也能用：本地别名表已经能覆盖大部分说法。</div>';

    $$('[data-del-prov]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('删除这个服务商？')) return;
        await api('/api/providers/' + b.dataset.delProv, { method: 'DELETE' });
        loadProviders();
        toast('已删除');
      };
    });
  } catch { /* 未授权时静默 */ }
}

// 设置项改动即保存（不用"保存"按钮，少一次点击也少一次忘点）
function bindSetting(id, key, transform = (v) => v, after) {
  const el = $(id);
  if (!el) return;
  el.onchange = async () => {
    const raw = el.type === 'checkbox' ? el.checked : el.value;
    try {
      await api('/api/settings', { method: 'POST', body: { [key]: transform(raw) } });
      toast('已保存');
      const r = await api('/api/settings');
      S.data.settings = r.settings;
      if (after) after(raw);
    } catch (e) { toast(e.message); }
  };
}

bindSetting('#setConfirmTtl', 'confirm_ttl', Number);
bindSetting('#setCallTimeout', 'call_timeout', Number);
bindSetting('#setAsyncAfter', 'async_after', Number);
bindSetting('#setLogKeep', 'log_keep', Number);
bindSetting('#setDefaultApp', 'default_app', (v) => v || null);
bindSetting('#setLlmEnabled', 'llm_enabled', (v) => v === true, (on) => {
  // 出厂不带任何服务商，开关能点亮但后端不会真的启用——这里明说，免得以为坏了
  if (on && !$$('#provList .tool-line').length) {
    toast('还没有服务商，AI 兜底不会真正生效：先点「添加服务商」');
  }
});
bindSetting('#setLlmWhen', 'llm_when');
bindSetting('#setConfirmRisk', 'confirm_risk', (v) => (v ? v.split(',') : []));
bindSetting('#setLlmDefault', 'llm_default', (v) => v || '');

// ---- 添加/编辑应用向导 ------------------------------------------------

let WZ = { step: 1, editId: null, tested: false, tools: [], picked: {}, hasFull: false };

function setStep(n) {
  WZ.step = n;
  $$('.wstep').forEach((s) => s.classList.toggle('on', Number(s.dataset.step) === n));
  $$('[data-bar]').forEach((b) => b.classList.toggle('on', Number(b.dataset.bar) <= n));
  $('#wzPrev').style.display = n === 1 ? 'none' : '';
  $('#wzNext').textContent = n === 2 ? (WZ.editId ? '保存' : '完成接入') : '下一步';
  $('#wzTitle').textContent = n === 2 ? '选择启用的工具' : (WZ.editId ? '编辑应用' : '添加应用');
  $('#wzDesc').textContent = ['填写连接信息并测试', '决定放哪些工具给微信'][n - 1];
  // 第 1 步必须先测通；第 2 步至少有工具可选
  $('#wzNext').disabled = n === 1 ? !WZ.tested : !WZ.tools.length;
}

function openWizard(appId) {
  WZ = { step: 1, editId: appId, tested: false, tools: [], picked: {}, hasFull: false };

  const app = appId ? S.data.apps.find((a) => a.id === appId) : null;
  $('#wzLabel').value = app?.label || '';
  $('#wzId').value = app?.id || '';
  $('#wzId').disabled = !!app;
  $('#wzAlias').value = (app?.aliases || []).join(' · ');
  $('#wzUrl').value = app?.url || '';
  $('#wzToken').value = '';
  $('#wzToken').placeholder = app?.hasToken ? '已设置，留空表示不修改' : '留空表示不需要鉴权';
  const ar = app?.allow_risk || ['read'];
  $('#wzRiskRead').checked = ar.includes('read');
  $('#wzRiskWrite').checked = ar.includes('write');
  $('#wzRiskHigh').checked = ar.includes('high');
  $('#testResult').classList.remove('on');
  $('#testBtn').textContent = '测试连接';
  $('#testBtn').disabled = false;

  // 编辑时直接进表单：地址和端口都是现成的，不用重走一遍
  if (app) {
    WZ.tested = true;
    // 用服务端「现在有」的全量工具。只读 this.tools 的话，应用侧新增的工具
    // 早被 include 白名单过滤掉了，编辑页里根本看不见，只能点一次测试连接绕出来。
    const avail = app.available || [];
    WZ.hasFull = avail.length > 0;
    WZ.tools = avail.length
      ? avail.map((t) => ({ ...t, appId: app.id, appLabel: app.label || app.id }))
      : S.data.tools.filter((t) => t.appId === appId).map((t) => ({ ...t }));
    WZ.picked = {};
    const inc = app.tools?.include || [];
    for (const t of WZ.tools) {
      WZ.picked[t.name] = avail.length ? t.enabled !== false : (inc.length ? inc.includes(t.name) : true);
    }
    buildTools();
  }
  setStep(1);
  $('#appModal').classList.remove('hidden');
}

function closeWizard() {
  $('#appModal').classList.add('hidden');
}

function buildTools() {
  // enabled 只有编辑时才有：服务端报的是「现在是否启用」，用来标出后来新增/被关掉的
  const off = WZ.tools.filter((t) => t.enabled === false).length;
  const hint = `发现 ${WZ.tools.length} 个工具${off ? `，其中 ${off} 个还没启用（应用侧新加的多半在这里）` : ''}。只勾你日常真的会用的——放太多会稀释识别准确率。`;
  $('#toolHint').textContent = hint;

  const order = { read: 0, write: 1, high: 2 };
  const list = [...WZ.tools].sort((a, b) => (order[a.risk] - order[b.risk]) || a.name.localeCompare(b.name));

  $('#toolPick').innerHTML = list.map((t) => {
    const on = WZ.picked[t.name] ? 'on' : '';
    return `<div class="tool-row ${WZ.picked[t.name] ? '' : 'off'}" data-tool="${esc(t.name)}">
      <div class="cb ${on}"></div>
      <div style="flex:1; min-width:0">
        <div class="tn">${esc(t.name)}</div>
        <div class="td2">${esc(t.title || t.description || '')}</div>
      </div>
      ${t.enabled === false ? '<span class="badge ghost">未启用</span>' : ''}
      <span class="badge ${RISK_CLS[t.risk]}">${RISK[t.risk]}</span>
    </div>`;
  }).join('');

  $$('#toolPick .tool-row').forEach((row) => {
    row.onclick = () => {
      const n = row.dataset.tool;
      WZ.picked[n] = !WZ.picked[n];
      row.classList.toggle('off', !WZ.picked[n]);
      row.querySelector('.cb').classList.toggle('on', WZ.picked[n]);
      setStep(WZ.step);
    };
  });
}

$('#addAppBtn').onclick = () => openWizard(null);
$('#wzCancel').onclick = closeWizard;
$('#wzPrev').onclick = () => setStep(Math.max(1, WZ.step - 1));

function draftApp() {
  const risks = [];
  if ($('#wzRiskRead').checked) risks.push('read');
  if ($('#wzRiskWrite').checked) risks.push('write');
  if ($('#wzRiskHigh').checked) risks.push('high');
  return {
    id: $('#wzId').value.trim() || $('#wzLabel').value.trim().toLowerCase().replace(/\s+/g, '-'),
    label: $('#wzLabel').value.trim(),
    aliases: $('#wzAlias').value.split(/[·,，、\s]+/).map((s) => s.trim()).filter(Boolean),
    url: $('#wzUrl').value.trim(),
    allow_risk: risks.length ? risks : ['read'],
  };
}

$('#testBtn').onclick = async () => {
  const btn = $('#testBtn');
  const box = $('#testResult');
  const draft = draftApp();
  if (!draft.url) { toast('先填端点地址'); return; }
  if (!/^https?:\/\//.test(draft.url)) { toast('地址要以 http:// 或 https:// 开头'); return; }

  btn.disabled = true;
  btn.textContent = '测试中…';
  box.classList.remove('on', 'ok', 'bad');

  try {
    const r = await api('/api/apps/test', { method: 'POST', body: { ...draft, token: $('#wzToken').value } });
    box.classList.add('on', r.ok ? 'ok' : 'bad');
    if (r.ok) {
      WZ.tested = true;
      WZ.hasFull = true;      // r.tools 是服务端此刻的全量清单
      WZ.tools = r.tools;
      WZ.picked = {};
      for (const t of r.tools) WZ.picked[t.name] = t.risk === 'read';   // 只读默认勾，其余手动
      box.innerHTML = `<p class="tr-title ok">连接成功</p>
        <div class="tr-rows">
          <span>协议版本</span><span class="mono">${esc(r.protocolVersion || '—')}</span>
          <span>服务端</span><span>${esc(r.serverInfo?.name || '—')} ${esc(r.serverInfo?.version || '')}</span>
          <span>发现工具</span><span>${r.tools.length} 个</span>
          <span>往返耗时</span><span>${r.ms} ms</span>
        </div>`;
      btn.textContent = '重新测试';
    } else {
      WZ.tested = false;
      box.innerHTML = `<p class="tr-title bad">连接失败</p>
        <div style="color:var(--red); margin-bottom:8px">${esc(r.message)}</div>
        ${r.hint ? `<div class="tr-rows"><span>怎么办</span><span>${esc(r.hint)}</span></div>` : ''}`;
      btn.textContent = '重新测试';
    }
    box.scrollIntoView({ block: 'nearest' });
  } catch (e) {
    box.classList.add('on', 'bad');
    box.innerHTML = `<p class="tr-title bad">测试没跑成</p><div style="color:var(--red)">${esc(e.message)}</div>`;
    btn.textContent = '重新测试';
  } finally {
    btn.disabled = false;
    setStep(WZ.step);   // 只刷新按钮可用状态，别顺带跳步
  }
};

$('#wzNext').onclick = async () => {
  if (WZ.step === 1) {
    if (!WZ.tested) { toast('先点「测试连接」，通过了才能继续'); return; }
    buildTools();
    setStep(2);
    return;
  }

  // 保存
  const draft = draftApp();
  const include = Object.entries(WZ.picked).filter(([, v]) => v).map(([k]) => k);
  if (!include.length) { toast('至少勾一个工具'); return; }
  if (!draft.id) { toast('缺少标识'); return; }

  // 全勾就等于不设白名单：include 留空 = 全放开，应用侧以后新增的工具
  // 不用回来改配置就能直接生效。只有真的想限制时才写死名单。
  const whitelist = (WZ.hasFull && include.length === WZ.tools.length) ? [] : include;

  const btn = $('#wzNext');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const r = await api('/api/apps', {
      method: 'POST',
      body: { ...draft, token: $('#wzToken').value, tools: { include: whitelist } },
    });
    closeWizard();
    await refreshAll();
    if (r.status === 'online') toast(`已保存，「${draft.label || draft.id}」${r.toolCount} 个工具`);
    else toast(`已保存，但现在连不上：${r.error?.message || ''}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = WZ.editId ? '保存' : '完成接入';
  }
};

async function editApp(id) {
  openWizard(id);
}

// ---- AI 服务商 --------------------------------------------------------

// 预设只是"填好地址和模型名"的快捷方式，不在表里的厂商选自定义即可。
// 后端只认两种协议：openai（/chat/completions）与 anthropic（/v1/messages）。
const PRESETS = {
  deepseek: { type: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  openai: { type: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { type: 'openai', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  dashscope: { type: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { type: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  siliconflow: { type: 'openai', base_url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  openrouter: { type: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  groq: { type: 'openai', base_url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  ollama: { type: 'openai', base_url: 'http://192.168.1.10:11434/v1', model: 'qwen2.5:7b' },
  anthropic: { type: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
};

$('#pvPreset').onchange = () => {
  const p = PRESETS[$('#pvPreset').value];
  if (!p) return;
  $('#pvId').value = $('#pvPreset').value;
  $('#pvType').value = p.type;
  $('#pvBase').value = p.base_url;
  $('#pvModel').value = p.model;
};

$('#addProvBtn').onclick = () => {
  $('#pvPreset').value = '';
  $('#pvId').value = '';
  $('#pvType').value = 'openai';
  $('#pvBase').value = '';
  $('#pvModel').value = '';
  $('#pvKey').value = '';
  $('#pvResult').textContent = '';
  $('#pvModelList').innerHTML = '';
  $('#pvModelHint').style.color = '';
  $('#pvModelHint').textContent = '模型名会随厂商迭代而过期，填之前点「拉取列表」拿最新的；也可以直接手输。';
  $('#provModal').classList.remove('hidden');
};
$('#pvCancel').onclick = () => $('#provModal').classList.add('hidden');

function provDraft() {
  return {
    id: $('#pvId').value.trim(),
    type: $('#pvType').value,
    base_url: $('#pvBase').value.trim(),
    model: $('#pvModel').value.trim(),
    api_key: $('#pvKey').value,
  };
}

$('#pvTest').onclick = async () => {
  const d = provDraft();
  const out = $('#pvResult');
  if (!d.base_url || !d.model) { out.style.color = 'var(--red)'; out.textContent = '先填地址和模型'; return; }
  out.style.color = 'var(--text-faint)';
  out.textContent = '测试中…';
  try {
    const r = await api('/api/providers/test', { method: 'POST', body: d });
    if (r.ok) {
      out.style.color = 'var(--green)';
      out.textContent = `通了 · ${r.model} · ${r.ms} ms`;
    } else {
      out.style.color = 'var(--red)';
      out.textContent = r.message;
    }
  } catch (e) { out.style.color = 'var(--red)'; out.textContent = e.message; }
};

// 模型名会过期（DeepSeek 的 deepseek-chat 已退役），所以不靠猜：问端点要清单。
// 已经存过 key 的不必重填——后端在 api_key 为空时会用保存的那份。
$('#pvFetchModels').onclick = async () => {
  const d = provDraft();
  const btn = $('#pvFetchModels');
  const hint = $('#pvModelHint');
  if (!d.base_url) { toast('先填接口地址'); return; }
  btn.disabled = true;
  const t0 = btn.textContent;
  btn.textContent = '拉取中…';
  try {
    const r = await api('/api/providers/models', { method: 'POST', body: { id: d.id, type: d.type, base_url: d.base_url, api_key: d.api_key } });
    if (!r.ok) {
      hint.style.color = 'var(--red)';
      hint.textContent = r.message;
      return;
    }
    const list = r.models.slice().sort();
    $('#pvModelList').innerHTML = list.map((m) => `<option value="${esc(m)}"></option>`).join('');
    // 没填模型就挑一个能用的兜底：优先 flash / mini / 便宜那类
    if (!d.model) {
      const pick = list.find((m) => /flash|mini|lite|turbo|small/i.test(m)) || list[0];
      $('#pvModel').value = pick;
    }
    hint.style.color = 'var(--text-faint)';
    hint.textContent = `拉到 ${list.length} 个模型，点输入框右侧箭头选；也可以直接手输。`;
    toast(`共 ${list.length} 个模型`);
  } catch (e) {
    hint.style.color = 'var(--red)';
    hint.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t0;
  }
};

$('#pvSave').onclick = async () => {
  const d = provDraft();
  if (!d.id) { toast('先填标识'); return; }
  if (!d.base_url || !d.model) { toast('先填地址和模型'); return; }
  try {
    await api('/api/providers', { method: 'POST', body: d });
    $('#provModal').classList.add('hidden');
    loadProviders();
    toast('已保存');
  } catch (e) { toast(e.message); }
};

// ---- 执行工具 ---------------------------------------------------------

let RUN = { key: null, tool: null };

function openRunner(key) {
  const t = S.data.tools.find((x) => x.key === key);
  if (!t) return;
  RUN = { key, tool: t };
  $('#runTitle').textContent = t.title || t.name;
  $('#runDesc').textContent = `${t.appLabel} · ${key} · ${RISK[t.risk]}`;
  $('#runResult').classList.remove('on', 'ok', 'bad');

  const req = t.required || [];
  $('#runFields').innerHTML = req.length
    ? req.map((r) => `<div class="field"><label>${esc(r)}</label><input data-arg="${esc(r)}" placeholder="必填"></div>`).join('')
    : '<p class="hint" style="margin:0 0 4px">这个工具不需要参数。</p>';
  $('#runGo').disabled = false;
  $('#runGo').textContent = '执行';
  $('#runModal').classList.remove('hidden');
}

$('#runCancel').onclick = () => $('#runModal').classList.add('hidden');

$('#runGo').onclick = async () => {
  const args = {};
  $$('#runFields [data-arg]').forEach((i) => { args[i.dataset.arg] = i.value; });
  const btn = $('#runGo');
  const box = $('#runResult');
  btn.disabled = true;
  btn.textContent = '执行中…';
  try {
    let r = await api('/api/exec', { method: 'POST', body: { key: RUN.key, args } });
    if (r.needConfirm) {
      if (confirm(`${r.reason}\n\n确定执行？`)) {
        r = await api('/api/exec', { method: 'POST', body: { key: RUN.key, args, confirm: true } });
      } else {
        btn.disabled = false; btn.textContent = '执行';
        return;
      }
    }
    box.classList.add('on', r.ok ? 'ok' : 'bad');
    box.innerHTML = `<p class="tr-title ${r.ok ? 'ok' : 'bad'}">${r.ok ? '成功' : '失败'} · ${r.ms} ms</p>
      <pre style="margin:0; white-space:pre-wrap; font:12px/1.65 ui-monospace,Menlo,Consolas,monospace; color:var(--text-dim); max-height:280px; overflow:auto">${esc(r.text || '')}</pre>`;
  } catch (e) {
    box.classList.add('on', 'bad');
    box.innerHTML = `<p class="tr-title bad">执行失败</p><div style="color:var(--red)">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '执行';
  }
};

// ---- 退出登录 ---------------------------------------------------------

async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch { /* 网络断了也要把界面送走，否则用户以为没登出 */ }
  location.replace('/login');
}

$('#logoutBtn2').onclick = doLogout;

// ---- 修改密码 ---------------------------------------------------------

function setCpHint(msg, bad) {
  const el = $('#cpHint');
  el.textContent = msg || '';
  el.style.color = bad ? 'var(--red)' : 'var(--text-faint)';
}

$('#chpwBtn').onclick = () => {
  $('#cpOld').value = '';
  $('#cpNew').value = '';
  $('#cpNew2').value = '';
  $('#cpGo').disabled = false;
  $('#cpGo').textContent = '确定';
  setCpHint('');
  $('#chpwModal').classList.remove('hidden');
  setTimeout(() => $('#cpOld').focus(), 0);
};

$('#cpCancel').onclick = () => $('#chpwModal').classList.add('hidden');

// 本地先挡一道，省一次往返；服务端仍会独立校验（前端校验永远不算数）
$('#cpGo').onclick = async () => {
  const oldPw = $('#cpOld').value;
  const np = $('#cpNew').value;
  const np2 = $('#cpNew2').value;
  if (!oldPw) return setCpHint('请输入原密码', true);
  if (np.length < 8) return setCpHint('新密码至少 8 位', true);
  if (/^\d+$/.test(np)) return setCpHint('新密码不能全是数字，请混入字母或符号', true);
  if (np !== np2) return setCpHint('两次输入的新密码不一致', true);
  if (np === oldPw) return setCpHint('新密码和原密码一样，换一个', true);

  const btn = $('#cpGo');
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    await api('/api/auth/password', { method: 'POST', body: { oldPassword: oldPw, newPassword: np, confirm: np2 } });
    $('#chpwModal').classList.add('hidden');
    toast('密码已修改，请用新密码重新登录');
    setTimeout(() => location.replace('/login'), 900);
  } catch (e) {
    setCpHint(e.message, true);
    btn.disabled = false;
    btn.textContent = '确定';
  }
};

// ---- 主循环 -----------------------------------------------------------

function renderChrome() {
  const d = S.data;
  if (!d) return;
  const wx = d.wechat;
  const pill = $('#wxPill');
  const cls = wx.online ? '' : (wx.status === 'scanning' ? 'warn' : 'off');
  pill.innerHTML = `<span class="dot ${cls}"></span><span>${wx.online ? '微信在线' : (wx.status === 'scanning' ? '等待扫码' : '微信未上线')}</span>`;
  $('#brandSub').textContent = wx.online ? (wx.botId || '已连接') : '未连接';
  $('#navApps').textContent = d.apps.length;
  $('#navTools').textContent = d.toolCount;
  $('#verLabel').textContent = 'v' + d.version;
  const up = d.uptime;
  $('#upLabel').textContent = up > 86400 ? `${Math.floor(up / 86400)}天` : (up > 3600 ? `${Math.floor(up / 3600)}小时` : `${Math.floor(up / 60)}分钟`);
}

async function refreshAll() {
  try {
    const d = await api('/api/state');
    const logs = await api('/api/logs?offset=0&limit=5');
    d.recent = logs.rows;
    S.data = d;
    renderChrome();
    renderOverview();
    renderApps();
    renderTools();
    renderWxCard();
    if (!S._settingsFilled || document.activeElement?.tagName !== 'INPUT') fillSettings();
    S._settingsFilled = true;
    if (S.page === 'logs') loadLogs(S.logs.offset || 0);
  } catch (e) {
    if (!/令牌/.test(e.message)) console.error(e);
  }
}

$('#refreshBtn').onclick = () => { refreshAll(); toast('已刷新'); };

// 扫码中 1.5 秒一次，平时 5 秒一次——扫完能立刻看到上线，平时不折腾
function schedule() {
  clearTimeout(S.timer);
  const fast = S.data?.wechat?.status === 'scanning';
  S.timer = setTimeout(async () => {
    await refreshAll();
    schedule();
  }, fast ? 1500 : 5000);
}

(async () => {
  go(S.page);
  await refreshAll();
  schedule();
})();
