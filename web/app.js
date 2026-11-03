'use strict';

const bridge = window.api;

const state = {
  providers: [],   // {id, name, baseUrl, hasKey, models:[]}
  proxy: '',
  groupPrompt: '',
  members: [],
  messages: [],
  settings: { mode: 'manual', rounds: 1, moderatorId: null, searchEnabled: false },
  editingMemberId: null,
  running: false,
  stopRequested: false,
  activeRuns: new Set(),
  sessions: [],
  activeSessionId: null,
  collapsed: { sessions: false, members: false },
  kb: { enabled: true, budget: 12000, files: [] },
  kbCache: new Map(),
};

const DEFAULT_SAFETY_CAP = 200;   // 不限轮数时的默认上限，可在设置里改

function safetyCap() {
  const n = Number(state.settings.safetyCap);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SAFETY_CAP;
}

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------------- Markdown 渲染 ---------------- */

let mdConfigured = false;

function mdRender(text) {
  if (!window.marked || !window.DOMPurify) return escapeHtml(text);
  if (!mdConfigured) {
    window.marked.setOptions({ gfm: true, breaks: true });
    mdConfigured = true;
  }
  try {
    const raw = window.marked.parse(String(text || ''));
    const clean = window.DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
    const box = document.createElement('div');
    box.innerHTML = clean;
    box.querySelectorAll('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
    return box.innerHTML;
  } catch (e) {
    return escapeHtml(text);
  }
}

/** 流式输出用 requestAnimationFrame 节流，避免每个字都重排 */
function makeMdUpdater(el) {
  let pending = false;
  let latest = '';
  return (text) => {
    latest = text;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      el.innerHTML = mdRender(latest);
    });
  };
}

function initials(name) {
  const n = String(name || '?').trim();
  return n ? n.slice(0, 1).toUpperCase() : '?';
}

function reasoningLabel(v) {
  return ({ low: '低', medium: '中', high: '高' })[v] || v;
}

function providerOf(member) {
  return state.providers.find((p) => p.id === member.providerId) || null;
}

function providerName(id) {
  const p = state.providers.find((x) => x.id === id);
  return p ? p.name : '未指定供应商';
}

/* ---------------- 启动 ---------------- */

async function init() {
  const cfg = await bridge.getConfig();
  state.providers = cfg.providers || [];
  state.proxy = cfg.proxy || '';
  state.groupPrompt = cfg.groupPrompt || '';
  state.kb = cfg.kb || { enabled: true, budget: 12000, files: [] };
  state.collapsed = (cfg.settings && cfg.settings.collapsed) || { sessions: false, members: false };
  if (!Array.isArray(state.kb.files)) state.kb.files = [];
  state.members = cfg.members || [];
  state.settings = Object.assign(
    { mode: 'manual', rounds: 1, moderatorId: null, searchEnabled: false },
    cfg.settings || {}
  );

  const sres = await bridge.listSessions();
  state.sessions = sres.sessions || [];
  state.activeSessionId = sres.activeId;

  if (!state.sessions.length) {
    const s = await bridge.createSession('新会话');
    state.sessions = [{ id: s.id, title: s.title, messageCount: 0, updatedAt: Date.now() }];
    state.activeSessionId = s.id;
    state.messages = [];
  } else {
    if (!state.activeSessionId) state.activeSessionId = state.sessions[0].id;
    const data = await bridge.loadSession(state.activeSessionId);
    state.activeSessionId = data.id;
    state.messages = data.messages || [];
    if (Array.isArray(data.members)) {
      state.members = data.members;
    }
    if (data.kb && typeof data.kb === 'object') {
      state.kb = Object.assign({ enabled: true, budget: 12000, files: [] }, data.kb);
    } else if (state.kb.files && state.kb.files.length) {
      // 从旧版本升级：把全局知识库并入当前会话，避免资料丢失
      saveKbToSession();
    }
  }

  if (!state.members.length) seedMembers();

  bindEvents();
  renderAll();
}

function seedMembers() {
  const pid = state.providers[0] ? state.providers[0].id : null;
  state.members = [
    { id: uid(), name: 'A', providerId: pid, model: '', persona: '你是逻辑严谨的分析者，先给结论再给理由。', temp: 0.6, color: '#5b8def', enabled: true },
    { id: uid(), name: 'B', providerId: pid, model: '', persona: '你是挑剔的评审者，专门找漏洞和反例。', temp: 0.8, color: '#e06c5b', enabled: true },
  ];
  persistConfig();
}

/* ---------------- 持久化 ---------------- */

function persistConfig() {
  bridge.saveConfig({
    providers: state.providers.map((p) => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models,
    })),
    proxy: state.proxy,
    groupPrompt: state.groupPrompt,
    kb: state.kb,
    members: state.members,
    settings: state.settings,
  });
}

let saveTimer = null;
function persistChat() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.activeSessionId) return;
    await bridge.saveSession({
      id: state.activeSessionId,
      messages: state.messages,
      members: state.members,
      kb: state.kb,
    });
    const s = state.sessions.find((x) => x.id === state.activeSessionId);
    if (s) {
      s.messageCount = state.messages.length;
      s.updatedAt = Date.now();
      renderSessions();
    }
  }, 300);
}

/* ---------------- 应用内询问框（替代原生 confirm/prompt，避免窗口失焦） ---------------- */

let askResolver = null;

function askUser(opts = {}) {
  const {
    title = '请确认', message = '', input = false,
    defaultValue = '', okText = '确定', danger = false,
  } = opts;

  return new Promise((resolve) => {
    askResolver = resolve;
    $('#askTitle').textContent = title;
    $('#askMsg').textContent = message;
    const inp = $('#askInput');
    inp.hidden = !input;
    inp.value = input ? defaultValue : '';
    const ok = $('#askOk');
    ok.textContent = okText;
    ok.classList.toggle('dangerbtn', danger);
    $('#modalAsk').hidden = false;
    setTimeout(() => {
      if (input) { inp.focus(); inp.select(); } else { ok.focus(); }
    }, 0);
  });
}

function closeAsk(value) {
  $('#modalAsk').hidden = true;
  const r = askResolver;
  askResolver = null;
  if (r) r(value);
}

function bindAskModal() {
  $('#askOk').onclick = () => {
    const inp = $('#askInput');
    closeAsk(inp.hidden ? true : inp.value);
  };
  $('#askCancel').onclick = () => closeAsk(null);
  $('#askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeAsk($('#askInput').value); }
    if (e.key === 'Escape') { e.preventDefault(); closeAsk(null); }
  });
  $('#modalAsk').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modalAsk') closeAsk(null);
  });
}

/* ---------------- 会话 ---------------- */

function currentSession() {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderSessions() {
  const box = $('#sessionList');
  if (!box) return;
  box.innerHTML = '';
  const list = state.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!list.length) {
    box.innerHTML = '<div class="muted" style="padding:8px">还没有会话</div>';
    return;
  }

  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'session' + (s.id === state.activeSessionId ? ' active' : '');
    row.dataset.sid = s.id;
    row.innerHTML = `
      <div class="s-title" title="${escapeHtml(s.title || '未命名')}">${escapeHtml(s.title || '未命名')}</div>
      <div class="s-meta">${s.messageCount || 0} 条 · ${escapeHtml(fmtTime(s.updatedAt))}</div>
      <button class="s-del" title="删除会话">×</button>`;

    row.onclick = (e) => {
      if (e.target.classList.contains('s-del')) return;
      switchSession(s.id);
    };
    row.ondblclick = () => renameSession(s.id);
    row.querySelector('.s-del').onclick = async (e) => {
      e.stopPropagation();
      const ok = await askUser({
        title: '删除会话',
        message: `删除「${s.title}」？不可恢复。`,
        danger: true,
        okText: '删除',
      });
      if (!ok) return;
      const r = await bridge.deleteSession(s.id);
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.activeSessionId === s.id) {
        if (r.activeId) await switchSession(r.activeId);
        else {
          const ns = await bridge.createSession('新会话');
          state.sessions.unshift({ id: ns.id, title: ns.title, messageCount: 0, updatedAt: Date.now() });
          state.activeSessionId = ns.id;
          state.messages = [];
        }
      }
      renderSessions();
      renderMessages();
      refreshUsageTotal();
    };
    box.appendChild(row);
  }
}

async function switchSession(id) {
  if (id === state.activeSessionId) return;
  if (state.running) { pushSystem('正在生成，请先点「停止」'); return; }
  // 先保存当前会话
  if (state.activeSessionId) {
    await bridge.saveSession({
      id: state.activeSessionId,
      messages: state.messages,
      members: state.members,
      kb: state.kb,
    });
  }
  const data = await bridge.loadSession(id);
  state.activeSessionId = data.id;
  state.messages = data.messages || [];
  // 有 members 字段就用它（哪怕是空数组）；老会话没有该字段则沿用当前成员
  if (Array.isArray(data.members)) {
    state.members = data.members;
  }
  if (data.kb && typeof data.kb === 'object') {
    state.kb = Object.assign({ enabled: true, budget: 12000, files: [] }, data.kb);
  } else {
    state.kb = { enabled: true, budget: 12000, files: [] };
  }
  state.kbCache.clear();
  renderAll();
}

async function newSession() {
  if (state.running) { pushSystem('正在生成，请先点「停止」'); return; }
  if (state.activeSessionId) {
    await bridge.saveSession({ id: state.activeSessionId, messages: state.messages });
  }
  // 新会话：成员和知识库都留空
  const emptyKb = { enabled: true, budget: 12000, files: [] };
  const s = await bridge.createSession('新会话', [], emptyKb);
  state.sessions.unshift({ id: s.id, title: s.title, messageCount: 0, updatedAt: Date.now() });
  state.activeSessionId = s.id;
  state.messages = [];
  state.members = [];
  state.kb = emptyKb;
  state.kbCache.clear();
  renderAll();          // 整页重绘：成员栏、@ 快捷、用量统计一起清空
  $('#input').focus();
}

async function renameSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const t = await askUser({ title: '重命名会话', input: true, defaultValue: s.title });
  if (t === null) return;
  const title = t.trim() || '未命名';
  await bridge.renameSession({ id, title });
  s.title = title;
  renderSessions();
}

/** 首条消息自动当标题 */
function autoTitle(text) {
  const s = currentSession();
  if (!s) return;
  if (s.title && s.title !== '新会话') return;
  const title = String(text).replace(/^@+\S+\s*/, '').slice(0, 20) || '新会话';
  s.title = title;
  bridge.renameSession({ id: s.id, title });
  renderSessions();
}

/* ---------------- 渲染 ---------------- */

function applyLayout() {
  const app = document.querySelector('.app');
  app.classList.toggle('sessions-collapsed', Boolean(state.collapsed.sessions));
  app.classList.toggle('members-collapsed', Boolean(state.collapsed.members));
  const bs = $('#btnCollapseSessions');
  const bm = $('#btnCollapseMembers');
  if (bs) bs.textContent = state.collapsed.sessions ? '⟩' : '⟨';
  if (bm) bm.textContent = state.collapsed.members ? '⟩' : '⟨';
}

function toggleCollapse(which) {
  state.collapsed[which] = !state.collapsed[which];
  state.settings.collapsed = state.collapsed;
  applyLayout();
  persistConfig();
}

function renderAll() {
  applyLayout();
  renderSessions();
  renderMembers();
  renderQuickAt();
  renderMode();
  renderMessages();
  const rv = state.settings.rounds;
  $('#rounds').value = (rv === undefined || rv === null || rv === '') ? 1 : rv;
  refreshConnState();
  refreshUsageTotal();
}

function refreshConnState() {
  const el = $('#connState');
  if (!state.providers.length) { el.textContent = '未配置供应商'; return; }
  const ready = state.members.filter((m) => m.enabled !== false && m.model && providerOf(m)).length;
  const withKey = state.providers.filter((p) => p.hasKey).length;
  el.textContent = ready
    ? `已连接 · ${withKey} 个供应商 · ${ready} 个可用成员`
    : `${withKey} 个供应商 · 成员还没选模型`;
}

function renderMembers() {
  const box = $('#memberList');
  box.innerHTML = '';
  $('#memberCount').textContent = state.members.length;
  for (const m of state.members) {
    const row = document.createElement('div');
    row.className = 'member' + (m.enabled === false ? ' disabled' : '');
    row.innerHTML = `
      <div class="dot" style="background:${escapeHtml(m.color || '#5b8def')}">${escapeHtml(initials(m.name))}</div>
      <div class="meta">
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="model">${escapeHtml(providerName(m.providerId))} · ${escapeHtml(m.model || '未选模型')}${m.reasoning && m.reasoning !== 'off' ? ' · 思考:' + escapeHtml(reasoningLabel(m.reasoning)) : ''}</div>
      </div>`;
    row.onclick = () => openMemberModal(m.id);
    box.appendChild(row);
  }
}

function renderQuickAt() {
  const box = $('#quickAt');
  box.innerHTML = '';
  for (const m of state.members) {
    const pub = document.createElement('button');
    pub.className = 'chip';
    pub.textContent = '@' + m.name;
    pub.onclick = () => insertAt('@' + m.name + ' ');
    box.appendChild(pub);

    const priv = document.createElement('button');
    priv.className = 'chip priv';
    priv.textContent = '@@' + m.name;
    priv.title = '私密@：只有你和 TA 能看到';
    priv.onclick = () => insertAt('@@' + m.name + ' ');
    box.appendChild(priv);
  }
}

function insertAt(text) {
  const input = $('#input');
  input.value = input.value ? input.value + ' ' + text : text;
  input.focus();
}

function renderModeratorPick() {
  const wrap = $('#moderatorWrap');
  const sel = $('#moderatorSelect');
  if (!wrap || !sel) return;

  const show = state.settings.mode === 'moderator';
  wrap.hidden = !show;
  if (!show) return;

  const list = state.members.filter((m) => m.enabled !== false && m.model);
  const current = state.settings.moderatorId || (list[0] ? list[0].id : '');

  sel.innerHTML = list.length
    ? list.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('')
    : '<option value="">（没有可用成员）</option>';

  if (list.some((m) => m.id === current)) sel.value = current;
  else if (list[0]) sel.value = list[0].id;

  // 顺手把默认主持人写回设置，避免每次都要手动选一次
  if (sel.value && state.settings.moderatorId !== sel.value) {
    state.settings.moderatorId = sel.value;
  }
}

function renderMode() {
  for (const btn of document.querySelectorAll('.mode')) {
    btn.classList.toggle('active', btn.dataset.mode === state.settings.mode);
  }
  const hints = {
    manual: '发消息后按 @ 点名；不点名则所有成员依次回答',
    roundrobin: '每个成员轮流回答，轮数可调',
    moderator: '主持人决定下一个谁说；可选「结束」收尾',
  };
  const rounds = Number(state.settings.rounds) || 0;
  let hint = hints[state.settings.mode] || '';
  if (rounds === 0 && state.settings.mode !== 'manual') hint += '（轮数 0 = 不限，直到你点停止）';
  $('#modeHint').textContent = hint;
  renderModeratorPick();
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of state.messages) box.appendChild(messageNode(m));
  box.scrollTop = box.scrollHeight;
}

function messageNode(m) {
  const wrap = document.createElement('div');
  wrap.dataset.mid = m.id;
  wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'member') + (m.visibility === 'private' ? ' private' : '');

  if (m.role === 'system') {
    wrap.className = 'msg';
    wrap.innerHTML = `<div class="body"><div class="bubble muted">${escapeHtml(m.text)}</div>${
      m.action ? `<button class="act resume-btn">${escapeHtml(m.action.label)}</button>` : ''
    }</div>`;
    const btn = wrap.querySelector('.resume-btn');
    if (btn && m.action) btn.onclick = () => onResumeAction(m);
    return wrap;
  }

  const member = state.members.find((x) => x.id === m.memberId);
  const color = member ? member.color : (m.role === 'user' ? '#3a4358' : '#5b8def');
  const name = m.role === 'user' ? '我' : (member ? member.name : '未知成员');

  const badges = [];
  if (m.visibility === 'private') {
    const to = state.members.find((x) => (m.privateTo || []).includes(x.id));
    badges.push(`<span class="badge">🔒 ${escapeHtml(to ? to.name : '私密')}</span>`);
  }
  if (m.stopped) badges.push('<span class="badge stop">已停止</span>');
  if (m.truncated) badges.push('<span class="badge warn">⚠ 达到长度上限</span>');
  if (m.interrupted) badges.push('<span class="badge warn">⚠ 响应中断</span>');

  let acts = m.role === 'assistant'
    ? '<button class="act" data-act="regen">重新生成</button>'
    : '<button class="act" data-act="edit">编辑</button>';
  if (m.role === 'assistant' && (m.truncated || m.interrupted)) {
    acts = '<button class="act go" data-act="cont">继续生成</button>' + acts;
  }
  const actsHtml = `<span class="acts">${acts}<button class="act" data-act="cut">删除以下</button></span>`;

  wrap.innerHTML = `
    <div class="avatar" style="background:${escapeHtml(color)}">${escapeHtml(m.role === 'user' ? '我' : initials(name))}</div>
    <div class="body">
      <div class="head"><span class="who">${escapeHtml(name)}</span>${badges.join('')}${actsHtml}</div>
      <div class="bubble md">${mdRender(m.text || '')}</div>
      ${m.reasoning ? `<div class="reasoning">${escapeHtml(m.reasoning)}</div>` : ''}
      ${m.error ? `<div class="err">${escapeHtml(m.error)}</div>` : ''}
      ${usageHtml(m)}
    </div>`;

  wrap.querySelectorAll('.act').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      onMessageAction(m, btn.dataset.act);
    };
  });
  return wrap;
}

function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function usageOf(m) {
  if (!m.usage) return null;
  const prompt = m.usage.prompt_tokens ?? m.usage.promptTokens ?? 0;
  const completion = m.usage.completion_tokens ?? m.usage.completionTokens ?? 0;
  const total = m.usage.total_tokens ?? (prompt + completion);
  return { prompt, completion, total };
}

function usageHtml(m) {
  const u = usageOf(m);
  if (!u) return '';
  return `<div class="usage">↑${u.prompt} ↓${u.completion} · ${u.total} tokens</div>`;
}

function renderUsageInto(node, msg) {
  const u = usageOf(msg);
  if (!u) return;
  let el = node.querySelector('.usage');
  if (!el) {
    el = document.createElement('div');
    el.className = 'usage';
    node.querySelector('.body').appendChild(el);
  }
  el.textContent = `↑${u.prompt} ↓${u.completion} · ${u.total} tokens`;
}

/**
 * 窗口没焦点时（document.hasFocus() === false），
 * 页面里的光标不会显示、键盘也进不来，这里强制激活一次。
 */
async function ensureWindowFocus() {
  if (document.hasFocus()) return true;
  try {
    const r = await bridge.refocus();
    return Boolean(r && r.ok);
  } catch {
    return false;
  }
}

function refreshUsageTotal() {
  const el = $('#usageTotal');
  if (!el) return;
  let total = 0;
  for (const m of state.messages) {
    const u = usageOf(m);
    if (u) total += u.total;
  }
  el.textContent = total ? `累计 ${fmtNum(total)} tokens` : '';
}

/* ---------------- 上下文构建（私密隔离核心） ---------------- */

function visibleTo(msg, memberId) {
  if (msg.visibility !== 'private') return true;
  return (msg.privateTo || []).includes(memberId);
}

function buildMessages(member, extra, kbText, searchText) {
  const sysParts = [];
  if (state.groupPrompt) sysParts.push(state.groupPrompt);
  if (member.persona) sysParts.push(`【你的角色】${member.persona}`);
  sysParts.push('你正在一个多模型群聊里。你能看到其他成员的公开发言；发言时直接给内容，不要复述别人，也不要假装自己是别人。');
  sysParts.push(`群成员：${state.members.map((m) => m.name).join('、')}。你的名字是「${member.name}」。`);
  if (kbText) {
    sysParts.push('以下是用户提供的参考资料，回答时优先依据这些内容；资料没写的不要编造。\n\n' + kbText);
  }
  if (searchText) {
    sysParts.push('以下是刚刚联网搜索到的资料（可能过时或不完整），回答时参考它，并说明依据。\n\n' + searchText);
  }

  const list = [{ role: 'system', content: sysParts.join('\n\n') }];

  for (const m of state.messages) {
    if (!visibleTo(m, member.id)) continue;
    if (m.role === 'system') continue;

    if (m.role === 'user') {
      const prefix = m.visibility === 'private' ? '【私密消息，只有你能看到】' : '';
      list.push({ role: 'user', content: prefix + m.text });
    } else if (m.role === 'assistant') {
      if (!m.text) continue;
      if (m.memberId === member.id) list.push({ role: 'assistant', content: m.text });
      else list.push({ role: 'user', content: `[${m.name}]：${m.text}` });
    }
  }

  if (extra) list.push({ role: 'user', content: extra });
  return list;
}

/* ---------------- 知识库 ---------------- */

function kbKey(wantImages) {
  const files = state.kb.files.map((f) => f.path + ':' + (f.chars || 0)).join('|');
  return `${files}::${state.kb.budget}::${wantImages ? 'img' : 'ocr'}`;
}

async function getKbContext(member) {
  if (!state.kb.enabled || !state.kb.files.length) return { text: '', images: [] };
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  const query = lastUser ? lastUser.text : '';
  const wantImages = Boolean(member && member.supportsImages);
  const key = kbKey(wantImages);
  if (state.kbCache.has(key)) return state.kbCache.get(key);
  try {
    // 非视觉成员：挑一个「支持看图」的成员用它的模型做图片转写
    const ocrMember = state.members.find((m) => m.supportsImages && m.model && providerOf(m));
    const ocr = ocrMember ? { providerId: ocrMember.providerId, model: ocrMember.model } : null;

    const ctx = await bridge.kbContext({
      files: state.kb.files,
      budget: Number(state.kb.budget) || 12000,
      wantImages,
      ocr,
      query,
    });
    state.kbCache.set(key, ctx);
    return ctx;
  } catch (e) {
    pushSystem('读取知识库失败：' + String(e.message || e));
    return { text: '', images: [] };
  }
}

/* ---------------- 联网搜索 ---------------- */

async function prepareSearch(text) {
  if (!state.settings.searchEnabled) return '';
  const q = String(text).replace(/^@+\S+\s*/, '').trim().slice(0, 200);
  if (!q) return '';

  pushSystem('正在联网搜索：' + q);
  try {
    const r = await bridge.webSearch({ query: q, fetchPages: 3, maxChars: 1500 });
    if (!r.ok) {
      pushSystem('联网搜索失败：' + (r.error || '未知原因'));
      return '';
    }
    const list = (r.results || [])
      .map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet || ''}`)
      .join('\n');
    const pages = (r.pages || [])
      .map((p, i) => `【网页${i + 1}：${p.title}】\n${p.url}\n${p.content}`)
      .join('\n\n');

    pushSystem(`已联网搜索（${r.source}）：参考 ${(r.results || []).length} 条结果，抓取 ${(r.pages || []).length} 个网页`);
    return `【搜索结果】\n${list}\n\n【网页正文摘录】\n${pages}`;
  } catch (e) {
    pushSystem('联网搜索异常：' + String(e.message || e));
    return '';
  }
}

/* ---------------- 运行成员 ---------------- */

async function runMember(member, opts = {}) {
  const provider = providerOf(member);
  if (!provider) {
    pushSystem(`成员「${member.name}」还没有选供应商`);
    return null;
  }

  const msg = {
    id: uid(), role: 'assistant', memberId: member.id, name: member.name,
    text: '', reasoning: '',
    visibility: opts.visibility || 'public', privateTo: opts.privateTo || [],
    ts: Date.now(),
  };
  state.messages.push(msg);
  const node = messageNode(msg);
  $('#messages').appendChild(node);
  $('#messages').scrollTop = $('#messages').scrollHeight;

  const bubble = node.querySelector('.bubble');
  const updateMd = makeMdUpdater(bubble);
  const runId = uid();
  state.activeRuns.add(runId);

  const offDelta = bridge.onDelta((d) => {
    if (d.runId !== runId) return;
    if (d.type === 'usage') {
      msg.usage = d.usage;
      renderUsageInto(node, msg);
      refreshUsageTotal();
      return;
    }
    if (d.type === 'content') {
      msg.text += d.text;
      updateMd(msg.text);
      $('#messages').scrollTop = $('#messages').scrollHeight;
    } else if (d.type === 'reasoning') {
      msg.reasoning += d.text;
      let r = node.querySelector('.reasoning');
      if (!r) {
        r = document.createElement('div');
        r.className = 'reasoning';
        node.querySelector('.body').appendChild(r);
      }
      r.textContent = msg.reasoning;
    }
  });

  try {
    const kb = await getKbContext(member);
    const res = await bridge.run({
      runId,
      providerId: provider.id,
      model: member.model,
      messages: buildMessages(member, opts.extra, kb.text, state.currentSearchText || ''),
      images: kb.images,
      temperature: typeof member.temp === 'number' ? member.temp : 0.7,
      maxTokens: Number(member.maxTokens) || 0,
      reasoning: member.reasoning || 'off',
    });
    if (res.usage) {
      msg.usage = res.usage;
      renderUsageInto(node, msg);
    }
    if (res.finishReason) msg.finishReason = res.finishReason;
    if (res.truncated) msg.truncated = true;
    if (res.interrupted) msg.interrupted = true;

    if (!res.ok) {
      if (/abort|cancel/i.test(String(res.error || ''))) {
        msg.stopped = true;
      } else {
        msg.error = res.error || '请求失败';
        node.querySelector('.body').insertAdjacentHTML('beforeend', `<div class="err">${escapeHtml(msg.error)}</div>`);
      }
    } else if (!msg.text && res.text) {
      msg.text = res.text;
      bubble.innerHTML = mdRender(msg.text);
    }
  } catch (e) {
    if (/abort|cancel/i.test(String(e.message || e))) msg.stopped = true;
    else msg.error = String(e.message || e);
  } finally {
    offDelta();
    state.activeRuns.delete(runId);
    refreshUsageTotal();
    if (msg.truncated || msg.interrupted) {
      const fresh = messageNode(msg);
      node.parentNode && node.parentNode.replaceChild(fresh, node);
    }
    persistChat();
  }
  return msg;
}

/* ---------------- 继续生成 ---------------- */

async function continueMessage(m) {
  if (state.running) { pushSystem('正在生成，请先点「停止」或等待完成'); return; }
  const member = state.members.find((x) => x.id === m.memberId);
  const provider = member && providerOf(member);
  if (!member || !provider) { pushSystem('找不到该成员的供应商'); return; }

  const node = document.querySelector(`[data-mid="${m.id}"]`);
  if (!node) return;
  const bubble = node.querySelector('.bubble');

  m.truncated = false;
  m.interrupted = false;

  state.running = true;
  state.stopRequested = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;

  const runId = uid();
  state.activeRuns.add(runId);
  const updateMd = makeMdUpdater(bubble);
  const off = bridge.onDelta((d) => {
    if (d.runId !== runId || d.type !== 'content') return;
    m.text += d.text;
    updateMd(m.text);
    $('#messages').scrollTop = $('#messages').scrollHeight;
  });

  try {
    const res = await bridge.run({
      runId,
      providerId: provider.id,
      model: member.model,
      messages: buildMessages(member, '请接着上面的内容继续写，从断开的地方开始，不要重复已经写过的部分。'),
      temperature: typeof member.temp === 'number' ? member.temp : 0.7,
      maxTokens: Number(member.maxTokens) || Number(m.maxTokens) || 8192,
      reasoning: member.reasoning || 'off',
    });
    if (res.ok) {
      if (!m.text && res.text) m.text = res.text;
      m.usage = mergeUsage(m.usage, res.usage);
      if (res.finishReason) m.finishReason = res.finishReason;
      if (res.truncated) m.truncated = true;
      if (res.interrupted) m.interrupted = true;
    } else if (!/abort|cancel/i.test(String(res.error || ''))) {
      pushSystem('继续生成失败：' + (res.error || '未知错误'));
    }
  } finally {
    off();
    state.activeRuns.delete(runId);
    state.running = false;
    $('#btnSend').disabled = false;
    $('#btnStop').hidden = true;
    renderMessages();
    refreshUsageTotal();
    persistChat();
  }
}

function mergeUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const pick = (x, k1, k2) => (x[k1] ?? x[k2] ?? 0);
  const prompt = pick(a, 'prompt_tokens', 'promptTokens') + pick(b, 'prompt_tokens', 'promptTokens');
  const completion = pick(a, 'completion_tokens', 'completionTokens') + pick(b, 'completion_tokens', 'completionTokens');
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/* ---------------- 打断 ---------------- */

function stopAll() {
  if (!state.running) return;
  state.stopRequested = true;
  state.activeRuns.forEach((id) => bridge.abort(id));
  pushSystem('已请求停止');
}

/* ---------------- 消息操作 ---------------- */

function cutFrom(msgId) {
  const idx = state.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  state.messages.splice(idx);
  renderMessages();
  refreshUsageTotal();
  persistChat();
}

function onMessageAction(m, act) {
  if (state.running) { pushSystem('正在生成，请先点「停止」'); return; }
  if (act === 'cut') { cutFrom(m.id); return; }
  if (act === 'cont') { continueMessage(m); return; }

  if (act === 'regen') {
    const member = state.members.find((x) => x.id === m.memberId);
    if (!member) return;
    const vis = m.visibility;
    const to = m.privateTo;
    cutFrom(m.id);
    state.running = true;
    $('#btnSend').disabled = true;
    runMember(member, { visibility: vis, privateTo: to })
      .finally(() => {
        state.running = false;
        $('#btnSend').disabled = false;
        persistChat();
      });
    return;
  }

  if (act === 'edit') {
    const to = state.members.find((x) => (m.privateTo || []).includes(x.id));
    const prefix = m.visibility === 'private' && to ? `@@${to.name} ` : '';
    cutFrom(m.id);
    const input = $('#input');
    input.value = prefix + m.text;
    input.focus();
  }
}

/* ---------------- 调度 ---------------- */

function parseInput(raw) {
  const text = raw.trim();
  const priv = text.match(/^@@(\S+)\s+([\s\S]+)$/);
  if (priv) return { text: priv[2].trim(), targetName: priv[1], private: true };
  const pub = text.match(/^@(\S+)\s+([\s\S]+)$/);
  if (pub) return { text: pub[2].trim(), targetName: pub[1], private: false };
  return { text, targetName: null, private: false };
}

function findMember(name) {
  if (!name) return null;
  const exact = state.members.find((m) => m.name === name);
  if (exact) return exact;
  return state.members.find((m) => m.name.includes(name) || name.includes(m.name)) || null;
}

async function send() {
  if (state.running) return;
  const raw = $('#input').value;
  if (!raw.trim()) return;

  const parsed = parseInput(raw);
  if (!parsed.text) return;

  const target = findMember(parsed.targetName);
  if (parsed.targetName && !target) { pushSystem(`没有找到成员「${parsed.targetName}」`); return; }

  if (!state.providers.length) { openSettings(); return; }

  const userMsg = {
    id: uid(), role: 'user', text: parsed.text,
    visibility: parsed.private ? 'private' : 'public',
    privateTo: target ? [target.id] : [],
    ts: Date.now(),
  };
  state.messages.push(userMsg);
  $('#messages').appendChild(messageNode(userMsg));
  $('#input').value = '';
  autoTitle(userMsg.text);
  persistChat();

  state.running = true;
  state.stopRequested = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;
  try {
    state.currentSearchText = await prepareSearch(userMsg.text);
    const enabled = state.members.filter((m) => m.enabled !== false && m.model && providerOf(m));

    if (target) {
      await runMember(target, { visibility: userMsg.visibility, privateTo: userMsg.privateTo });
      return;
    }

    const rounds = Math.max(0, Number(state.settings.rounds) || 0);  // 0 = 不限

    if (!enabled.length) {
      pushSystem('没有可用成员：请在成员设置里选择供应商和模型');
      return;
    }

    await runDiscussion(state.settings.mode, rounds, enabled);
  } catch (e) {
    pushSystem('出错：' + String(e.message || e));
  } finally {
    state.running = false;
    state.stopRequested = false;
    state.currentSearchText = '';
    $('#btnSend').disabled = false;
    $('#btnStop').hidden = true;
    persistChat();
  }
}

/**
 * 执行一轮讨论。
 * rounds === 0 表示不限轮数，直到手动停止 / 主持人收尾 / 达到安全上限。
 */
async function runDiscussion(mode, rounds, enabled) {
  if (mode === 'roundrobin') {
    if (rounds === 0) {
      const cap = safetyCap();
      let spoken = 0;
      while (!state.stopRequested && spoken < cap) {
        for (const m of enabled) {
          if (state.stopRequested || spoken >= cap) break;
          await runMember(m);
          spoken++;
        }
      }
      if (spoken >= cap && !state.stopRequested) {
        pushContinuePrompt(cap);
      }
    } else {
      for (let r = 0; r < rounds && !state.stopRequested; r++) {
        for (const m of enabled) {
          if (state.stopRequested) break;
          await runMember(m);
        }
      }
    }
    return;
  }

  if (mode === 'moderator') {
    await runModerated(rounds, enabled);
    return;
  }

  for (const m of enabled) {
    if (state.stopRequested) break;
    await runMember(m);
  }
}

/** 到达安全上限时插入一条带「继续」按钮的系统消息 */
function pushContinuePrompt(cap) {
  const m = {
    id: uid(),
    role: 'system',
    text: `已达到安全上限（${cap || safetyCap()} 次发言），讨论已暂停。`,
    action: { label: `继续讨论（再来 ${cap || safetyCap()} 次）` },
    ts: Date.now(),
  };
  state.messages.push(m);
  $('#messages').appendChild(messageNode(m));
  $('#messages').scrollTop = $('#messages').scrollHeight;
  persistChat();
}

/** 点击「继续讨论」：再给一轮额度继续跑 */
async function onResumeAction(m) {
  if (state.running) { pushSystem('正在生成，请先点「停止」'); return; }

  m.action = null;               // 按钮点过就失效，避免重复触发
  renderMessages();

  const enabled = state.members.filter((x) => x.enabled !== false && x.model && providerOf(x));
  if (!enabled.length) { pushSystem('没有可用成员'); return; }

  state.running = true;
  state.stopRequested = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;
  try {
    await runDiscussion(state.settings.mode, 0, enabled);
  } catch (e) {
    pushSystem('继续讨论出错：' + String(e.message || e));
  } finally {
    state.running = false;
    state.stopRequested = false;
    $('#btnSend').disabled = false;
    $('#btnStop').hidden = true;
    persistChat();
  }
}

function pushSystem(text) {
  const m = { id: uid(), role: 'system', text, ts: Date.now() };
  state.messages.push(m);
  $('#messages').appendChild(messageNode(m));
  $('#messages').scrollTop = $('#messages').scrollHeight;
  persistChat();
}

function pickModerator(enabled) {
  if (state.settings.moderatorId) {
    const m = state.members.find((x) => x.id === state.settings.moderatorId);
    if (m) return m;
  }
  return enabled[0] || state.members[0];
}

async function runModerated(rounds, enabled) {
  const moderator = pickModerator(enabled);
  if (!moderator || !moderator.model) { pushSystem('主持人没有配置模型'); return; }
  const names = enabled.map((m) => m.name);
  const unlimited = rounds === 0;

  pushSystem(
    `主持人：${moderator.name}${unlimited ? '（不限轮数，随时可点「停止」）' : `（最多 ${rounds} 次发言）`}`
  );

  const cap = safetyCap();
  let i = 0;
  while (!state.stopRequested && (unlimited || i < rounds) && i < cap) {
    const instruction = [
      '现在轮到你当主持人。',
      `可选成员：${names.join('、')}。`,
      '请阅读群聊记录，决定下一个发言者，并给 TA 一句提示。',
      '如果你认为讨论已经充分、可以收尾了，就输出 {"done":true} 来结束讨论。',
      '只输出一行 JSON，不要解释：{"next":"成员名","prompt":"提示"} 或 {"done":true}',
    ].join('\n');

    const plan = parsePlan(await runSilent(moderator, instruction), names);

    if (plan.done) {
      pushSystem(`主持人 ${moderator.name} 宣布讨论结束。`);
      break;
    }

    const next = findMember(plan.next) || enabled[i % enabled.length];
    pushSystem(`第 ${i + 1} 次｜主持人 ${moderator.name}：请「${next.name}」发言 — ${plan.prompt || '（无提示）'}`);
    await runMember(next, { extra: plan.prompt ? `【主持人提示】${plan.prompt}` : '' });
    i++;
  }

  if (i >= cap && !state.stopRequested) {
    pushContinuePrompt(cap);
  }
}

function parsePlan(text, names) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const obj = JSON.parse(m[0]);
    const next = String(obj.next || obj.name || '');
    // 主持人可以用 done:true 或 next:"结束" 来收尾
    const done = obj.done === true || /^(结束|停止|收尾|end|stop|finish)$/i.test(next);
    return { done, next, prompt: obj.prompt || obj.question || '' };
  } catch {
    return { done: false, next: names[0] || '', prompt: '' };
  }
}

async function runSilent(member, extra) {
  const provider = providerOf(member);
  if (!provider) return '';
  const runId = uid();
  let text = '';
  const off = bridge.onDelta((d) => {
    if (d.runId === runId && d.type === 'content') text += d.text;
  });
  try {
    const res = await bridge.run({
      runId,
      providerId: provider.id,
      model: member.model,
      messages: buildMessages(member, extra),
      temperature: 0.4,
      reasoning: member.reasoning || 'off',
    });
    return res.ok ? (res.text || text) : text;
  } finally {
    off();
  }
}

/* ---------------- 供应商编辑 ---------------- */

function renderProviders() {
  const box = $('#providerList');
  box.innerHTML = '';

  if (!state.providers.length) {
    box.innerHTML = '<div class="muted">还没有供应商，点下面按钮添加。</div>';
    return;
  }

  state.providers.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'provider';
    card.dataset.id = p.id;
    card.dataset.idx = String(idx);
    card.innerHTML = `
      <div class="prow">
        <input class="pname" data-field="name" placeholder="名称" value="${escapeHtml(p.name || '')}" />
        <input data-field="baseUrl" placeholder="https://api.example.com/v1" value="${escapeHtml(p.baseUrl || '')}" />
      </div>
      <div class="prow">
        <input data-field="apiKey" type="password"
               placeholder="${p.hasKey ? 'Key 已保存（留空则不修改）' : 'sk-...'}" />
      </div>
      <div class="actions">
        <button class="mini" data-act="fetch">拉取模型</button>
        <button class="mini" data-act="clearKey">清除 Key</button>
        <button class="mini" data-act="remove">删除</button>
        <span class="status" data-role="status">${(p.models || []).length ? `已缓存 ${p.models.length} 个模型` : (p.hasKey ? '已保存 Key' : '未保存')}</span>
      </div>`;
    box.appendChild(card);
  });

  box.querySelectorAll('.provider').forEach((card) => {
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => onProviderAction(card, btn.dataset.act);
    });
  });
}

function readProviderCard(card) {
  const get = (f) => card.querySelector(`[data-field="${f}"]`).value.trim();
  return {
    id: card.dataset.id || undefined,
    name: get('name') || '未命名',
    baseUrl: get('baseUrl'),
    apiKey: card.querySelector('[data-field="apiKey"]').value.trim() || undefined,
  };
}

function collectProvidersFromDom() {
  return Array.from(document.querySelectorAll('#providerList .provider')).map((card) => {
    const draft = readProviderCard(card);
    const existing = state.providers.find((p) => p.id === draft.id);
    const keyInput = card.querySelector('[data-field="apiKey"]').value.trim();
    return {
      id: draft.id,
      name: draft.name,
      baseUrl: draft.baseUrl,
      models: existing ? existing.models : [],
      apiKey: keyInput || undefined,
      clearKey: card.dataset.clearKey === '1',
    };
  });
}

async function onProviderAction(card, act) {
  const draft = readProviderCard(card);
  const status = card.querySelector('[data-role="status"]');

  if (act === 'remove') {
    state.providers = state.providers.filter((p) => p.id !== card.dataset.id);
    renderProviders();
    return;
  }

  if (act === 'clearKey') {
    card.dataset.clearKey = '1';
    status.textContent = 'Key 将被清除（保存后生效）';
    return;
  }

  if (act === 'fetch') {
    card.dataset.clearKey = '';
    // 先把当前卡片（含 Key）落盘，否则主进程拿不到新 Key
    const providers = collectProvidersFromDom();
    await bridge.saveConfig({ providers, proxy: $('#proxy').value.trim(), groupPrompt: $('#groupPrompt').value });
    const cfg = await bridge.getConfig();
    state.providers = cfg.providers;

    const target = state.providers.find((p) => p.id === draft.id)
      || state.providers.find((p) => p.baseUrl === draft.baseUrl);
    status.textContent = '拉取中…';
    try {
      const models = await bridge.listModels(target ? target.id : undefined, draft.apiKey);
      if (target) {
        target.models = models;
        await bridge.saveConfig({
          providers: state.providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models })),
        });
      }
      status.textContent = `共 ${models.length} 个模型`;
      renderProviders();
    } catch (e) {
      status.textContent = '失败：' + String(e.message || e).slice(0, 80);
    }
  }
}

function addProvider() {
  state.providers.push({ id: uid(), name: '新供应商', baseUrl: '', hasKey: false, models: [] });
  renderProviders();
}

/* ---------------- 成员弹窗 ---------------- */

const CUSTOM_MODEL = '__custom__';

function renderModelOptions(providerId, currentModel) {
  const p = state.providers.find((x) => x.id === providerId);
  const models = (p && Array.isArray(p.models)) ? p.models.slice() : [];

  // 当前模型不在列表里（例如手填的），也要能显示
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);

  const sel = $('#mModelSelect');
  const custom = $('#mModelCustom');

  if (!models.length) {
    // 没缓存模型：直接让用户手填
    sel.innerHTML = `<option value="${CUSTOM_MODEL}">自定义输入…</option>`;
    sel.value = CUSTOM_MODEL;
    custom.hidden = false;
    custom.value = currentModel || '';
    return;
  }

  sel.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
    + `<option value="${CUSTOM_MODEL}">自定义输入…</option>`;
  sel.value = currentModel && models.includes(currentModel) ? currentModel : models[0];
  custom.hidden = true;
  custom.value = '';
}

function openMemberModal(id) {
  const m = id ? state.members.find((x) => x.id === id) : null;
  // 列表残留（成员已被切换/删除）时，刷新界面而不是当成"新增"
  if (id && !m) { renderAll(); return; }

  state.editingMemberId = id;

  $('#modalSettings').hidden = true;   // 避免被设置弹窗的遮罩挡住

  if (!state.providers.length) {
    pushSystem('请先在「设置」里添加供应商');
    return;
  }

  $('#memberTitle').textContent = m ? '编辑成员' : '添加成员';
  $('#mName').value = m ? m.name : '';
  $('#mModelCustom').value = '';
  $('#mPersona').value = m ? m.persona : '';
  $('#mTemp').value = m ? m.temp : 0.7;
  $('#mColor').value = m ? m.color : '#5b8def';
  $('#mMaxTokens').value = m && m.maxTokens ? m.maxTokens : 0;
  $('#mVision').checked = Boolean(m && m.supportsImages);
  $('#mReasoning').value = (m && m.reasoning) || 'off';

  const sel = $('#mProvider');
  sel.innerHTML = state.providers
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.baseUrl ? ' — ' + escapeHtml(p.baseUrl) : ''}</option>`)
    .join('');
  const current = m && m.providerId ? m.providerId : state.providers[0].id;
  sel.value = current;
  renderModelOptions(current, m ? m.model : '');

  sel.onchange = () => renderModelOptions(sel.value, '');
  $('#mModelSelect').onchange = () => {
    $('#mModelCustom').hidden = $('#mModelSelect').value !== CUSTOM_MODEL;
  };

  $('#btnDeleteMember').style.display = m ? '' : 'none';
  $('#modalMember').hidden = false;
}

/* ---------------- 事件 ---------------- */

function bindEvents() {
  // 点遮罩关闭弹窗（否则遮罩会吃掉侧栏点击，看起来像"点不开"）
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  });

  // Esc 关闭所有弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
    }
  });

  bindAskModal();
  $('#btnSend').onclick = send;
  $('#btnStop').onclick = stopAll;
  $('#btnExport').onclick = doExport;

  // 点击输入区：先确保窗口被激活（原生对话框后可能失焦），再把光标放进去
  const composer = document.querySelector('.composer');
  composer.addEventListener('mousedown', async () => {
    if (!document.hasFocus()) {
      await ensureWindowFocus();
    }
  });
  composer.addEventListener('click', async (e) => {
    if (!document.hasFocus()) await ensureWindowFocus();
    const tag = e.target.tagName;
    if (tag === 'BUTTON') return;
    $('#input').focus();
    // 光标位置放到末尾，避免"点了但光标在最前面"的错觉
    const v = $('#input').value;
    $('#input').setSelectionRange(v.length, v.length);
  });

  // 窗口重新获得焦点时，如果焦点落在 body 上，归还给输入框
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) $('#input').focus();
  });

  // 任何位置点击时若窗口失焦，尝试激活一次（覆盖侧栏/消息区点击）
  document.addEventListener('click', () => {
    if (!document.hasFocus()) ensureWindowFocus();
  });

  // Ctrl+Shift+D：输出焦点诊断到日志
  window.addEventListener('keydown', async (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) return;
    e.preventDefault();
    const inp = $('#input');
    const r = inp.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const info = {
      activeElement: document.activeElement.tagName + '#' + (document.activeElement.id || ''),
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      running: state.running,
      inputDisabled: inp.disabled,
      inputReadOnly: inp.readOnly,
      inputRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      hitElement: hit ? hit.tagName + '#' + (hit.id || '') + '.' + hit.className : 'null',
      viewport: { w: innerWidth, h: innerHeight },
    };
    let res = { ok: false, path: '(未写入)' };
    try { res = await bridge.diagDump(info); } catch (err) { /* 忽略 */ }
    pushSystem(
      `焦点诊断：activeElement=${info.activeElement}，hasFocus=${info.hasFocus}，` +
      `命中=${info.hitElement}，running=${info.running}\n日志：${res.path}`
    );
  });

  // Enter 发送；Shift+Enter 换行；输入法合成中（拼音选词）不发送
  $('#input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;   // 中文输入法正在选词
    if (e.shiftKey) return;                            // Shift+Enter 换行（走默认行为）
    if (e.ctrlKey || e.metaKey || e.altKey) return;    // 其它组合键不拦截
    e.preventDefault();
    send();
  });

  for (const btn of document.querySelectorAll('.mode')) {
    btn.onclick = () => {
      state.settings.mode = btn.dataset.mode;
      persistConfig();
      renderMode();
    };
  }

  $('#rounds').onchange = (e) => {
    state.settings.rounds = Math.max(0, Number(e.target.value) || 0);
    persistConfig();
    renderMode();
  };

  $('#moderatorSelect').onchange = (e) => {
    state.settings.moderatorId = e.target.value || null;
    persistConfig();
  };

  $('#searchEnabled').checked = Boolean(state.settings.searchEnabled);
  $('#searchEnabled').onchange = (e) => {
    state.settings.searchEnabled = e.target.checked;
    persistConfig();
  };

  $('#btnSettings').onclick = openSettings;
  $('#btnNewSession').onclick = newSession;
  $('#btnCollapseSessions').onclick = () => toggleCollapse('sessions');
  $('#btnCollapseMembers').onclick = () => toggleCollapse('members');
  $('#btnCloseSettings').onclick = () => { $('#modalSettings').hidden = true; };
  $('#btnAddProvider').onclick = addProvider;

  $('#btnAddKb').onclick = async () => {
    const paths = await bridge.kbPick();
    await ensureWindowFocus();
    if (!paths || !paths.length) return;
    const entries = await bridge.kbIndex(paths);
    const have = new Set(state.kb.files.map((f) => f.path));
    for (const e of entries) {
      if (!have.has(e.path)) state.kb.files.push(e);
    }
    state.kbCache.clear();
    renderKbList();
    saveKbToSession();
  };

  $('#kbEnabled').onchange = () => {
    state.settings.safetyCap = Math.max(1, Number($('#safetyCap').value) || DEFAULT_SAFETY_CAP);
    state.kb.enabled = $('#kbEnabled').checked;
    state.kbCache.clear();
    saveKbToSession();
  };

  // 文件夹导入（仅桌面版支持）
  const folderBtn = $('#btnAddKbFolder');
  if (folderBtn) {
    folderBtn.hidden = typeof bridge.kbPickFolder !== 'function';
    folderBtn.onclick = async () => {
      try {
        const r = await bridge.kbPickFolder();
        await ensureWindowFocus();
        if (!r || !r.paths || !r.paths.length) return;
        pushSystem(`正在解析 ${r.paths.length} 个文件…`);
        const entries = await bridge.kbIndex(r.paths);
        const have = new Set(state.kb.files.map((f) => f.path));
        for (const e of entries) if (!have.has(e.path)) state.kb.files.push(e);
        state.kbCache.clear();
        renderKbList();
        saveKbToSession();
        if (r.truncated) pushSystem('文件夹内文件过多，只导入了前 800 个。');
        const okCount = entries.filter((e) => e.ok).length;
        pushSystem(`已从文件夹导入 ${okCount}/${entries.length} 个文件。`);
      } catch (e) {
        pushSystem('导入文件夹失败：' + String(e.message || e));
      }
    };
  }

  $('#btnSaveSettings').onclick = async () => {
    const providers = collectProvidersFromDom();
    state.proxy = $('#proxy').value.trim();
    state.groupPrompt = $('#groupPrompt').value;
    state.kb.enabled = $('#kbEnabled').checked;
    state.kb.budget = Math.max(1000, Number($('#kbBudget').value) || 12000);
    state.kbCache.clear();

    await bridge.saveConfig({
      providers,
      proxy: state.proxy,
      groupPrompt: state.groupPrompt,
      members: state.members,
      settings: state.settings,
    });

    const cfg = await bridge.getConfig();
    state.providers = cfg.providers;
    state.members = cfg.members;
    $('#modalSettings').hidden = true;
    renderAll();
  };

  $('#btnAddMember').onclick = () => openMemberModal(null);
  $('#btnCloseMember').onclick = () => { $('#modalMember').hidden = true; };

  $('#btnSaveMember').onclick = () => {
    const name = $('#mName').value.trim() || '未命名';
    const providerId = $('#mProvider').value;
    const modelSel = $('#mModelSelect').value;
    const model = modelSel === CUSTOM_MODEL
      ? $('#mModelCustom').value.trim()
      : modelSel;
    const persona = $('#mPersona').value;
    const temp = Number($('#mTemp').value);
    const color = $('#mColor').value;

    const maxTokens = Math.max(0, Number($('#mMaxTokens').value) || 0);
    const reasoning = $('#mReasoning').value;
    const supportsImages = $('#mVision').checked;

    if (state.editingMemberId) {
      const m = state.members.find((x) => x.id === state.editingMemberId);
      Object.assign(m, { name, providerId, model, persona, temp, color, maxTokens, reasoning, supportsImages });
    } else {
      state.members.push({ id: uid(), name, providerId, model, persona, temp, color, maxTokens, reasoning, supportsImages, enabled: true });
    }
    persistConfig();
    $('#modalMember').hidden = true;
    renderAll();
  };

  $('#btnDeleteMember').onclick = () => {
    if (!state.editingMemberId) { $('#modalMember').hidden = true; return; }
    state.members = state.members.filter((m) => m.id !== state.editingMemberId);
    persistConfig();
    $('#modalMember').hidden = true;
    renderAll();
  };

  $('#btnClear').onclick = async () => {
    const ok = await askUser({
      title: '清空会话',
      message: '清空当前会话的全部消息？不可恢复。',
      danger: true,
      okText: '清空',
    });
    if (!ok) return;
    state.messages = [];
    await bridge.clearChat();
    renderMessages();
    refreshUsageTotal();
    if (document.hasFocus()) $('#input').focus();
  };
}

function saveKbToSession() {
  if (state.activeSessionId) {
    bridge.saveSession({
      id: state.activeSessionId,
      messages: state.messages,
      members: state.members,
      kb: state.kb,
    });
  }
  persistConfig();
}

function renderKbList() {
  const box = $('#kbList');
  if (!box) return;
  if (!state.kb.files.length) {
    box.innerHTML = '<div class="muted">还没有资料，点下面添加。</div>';
    return;
  }
  box.innerHTML = '';
  for (const f of state.kb.files) {
    const row = document.createElement('div');
    row.className = 'kb-item';
    const size = f.chars ? `${f.chars} 字` : (f.ok === false ? '解析失败' : '未解析');
    row.innerHTML = `
      <span class="kb-name" title="${escapeHtml(f.path)}">${f.kind === 'image' ? '🖼' : '📄'} ${escapeHtml(f.name)}</span>
      <span class="kb-size">${escapeHtml(size)}</span>
      <button class="kb-del" title="移除">×</button>`;
    row.querySelector('.kb-del').onclick = () => {
      state.kb.files = state.kb.files.filter((x) => x.path !== f.path);
      state.kbCache.clear();
      renderKbList();
      saveKbToSession();
    };
    box.appendChild(row);
  }
}

function openSettings() {
  $('#modalMember').hidden = true;
  $('#proxy').value = state.proxy || '';
  $('#groupPrompt').value = state.groupPrompt || '';
  $('#safetyCap').value = safetyCap();
  $('#kbEnabled').checked = state.kb.enabled !== false;
  $('#kbBudget').value = state.kb.budget || 12000;
  renderKbList();
  renderProviders();
  $('#modalSettings').hidden = false;
}

/* ---------------- 导出 ---------------- */

function buildMarkdown() {
  const lines = ['# AI 群聊记录', '', `导出时间：${new Date().toLocaleString()}`, ''];
  for (const m of state.messages) {
    if (m.role === 'system') { lines.push(`> ${m.text}`, ''); continue; }
    const member = state.members.find((x) => x.id === m.memberId);
    const who = m.role === 'user' ? '我' : (member ? member.name : '未知成员');
    const tag = m.visibility === 'private' ? '（私密）' : '';
    const u = usageOf(m);
    const tokens = u ? ` · ${u.total} tokens` : '';
    lines.push(`**${who}**${tag}${tokens}`, '', m.text || '', '');
  }
  return lines.join('\n');
}

async function doExport() {
  if (!state.messages.length) { pushSystem('还没有消息'); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  try {
    const res = await bridge.exportMarkdown({
      content: buildMarkdown(),
      defaultName: `ai-group-chat-${stamp}.md`,
    });
    // 另存为对话框同样可能让窗口失焦
    await ensureWindowFocus();
    if (res.ok) pushSystem('已导出到：' + res.path);
  } catch (e) {
    pushSystem('导出失败：' + String(e.message || e));
  }
}

init();
