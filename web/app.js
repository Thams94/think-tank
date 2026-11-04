'use strict';

const bridge = window.api;

const state = {
  providers: [],   // {id, name, baseUrl, hasKey, models:[]}
  proxy: '',
  groupPrompt: '',
  members: [],
  messages: [],
  settings: { mode: 'manual', rounds: 1, moderatorId: null, searchEnabled: false, plannerProviderId: null, plannerModel: null },
  editingMemberId: null,
  running: false,
  stopRequested: false,
  paused: false,
  activeRuns: new Set(),
  sessions: [],
  activeSessionId: null,
  collapsed: { sessions: false, members: false, issues: false },
  kb: { enabled: true, budget: 12000, files: [] },
  kbCache: new Map(),
  issues: [],
  currentIssueId: null,
  draftPlan: { requirement: '', feedback: [], team: [], issues: [], raw: '' },
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
  state.collapsed = Object.assign({ sessions: false, members: false, issues: false }, (cfg.settings && cfg.settings.collapsed) || {});
  if (!Array.isArray(state.kb.files)) state.kb.files = [];
  state.members = cfg.members || [];
  state.settings = Object.assign(
    { mode: 'manual', rounds: 1, moderatorId: null, searchEnabled: false, plannerProviderId: null, plannerModel: null },
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
    if (typeof data.groupPrompt === 'string') {
      state.groupPrompt = data.groupPrompt;
    } else if (state.groupPrompt) {
      saveKbToSession();      // 旧版本升级：把全局提示词并入当前会话
    }
    if (data.kb && typeof data.kb === 'object') {
      state.kb = Object.assign({ enabled: true, budget: 12000, files: [] }, data.kb);
    } else if (state.kb.files && state.kb.files.length) {
      // 从旧版本升级：把全局知识库并入当前会话，避免资料丢失
      saveKbToSession();
    }
    state.issues = Array.isArray(data.issues) ? data.issues : [];
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
  // 关键：在"安排保存"的时刻就锁定会话与内容，
  // 否则 300ms 内切换会话会把 A 的内容写进 B
  const sessionId = state.activeSessionId;
  const snapshot = {
    messages: state.messages,
    members: state.members,
    kb: state.kb,
    groupPrompt: state.groupPrompt,
    issues: state.issues,
  };
  saveTimer = setTimeout(async () => {
    if (!sessionId) return;
    await bridge.saveSession({
      id: sessionId,
      messages: snapshot.messages,
      members: snapshot.members,
      kb: snapshot.kb,
      groupPrompt: snapshot.groupPrompt,
      issues: snapshot.issues,
    });
    const s = state.sessions.find((x) => x.id === sessionId);
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
      groupPrompt: state.groupPrompt,
      issues: state.issues,
    });
  }
  const data = await bridge.loadSession(id);
  state.activeSessionId = data.id;
  state.messages = data.messages || [];
  // 有 members 字段就用它（哪怕是空数组）；老会话没有该字段则沿用当前成员
  if (Array.isArray(data.members)) {
    state.members = data.members;
  }
  state.groupPrompt = typeof data.groupPrompt === 'string' ? data.groupPrompt : '';
  if (data.kb && typeof data.kb === 'object') {
    state.kb = Object.assign({ enabled: true, budget: 12000, files: [] }, data.kb);
  } else {
    state.kb = { enabled: true, budget: 12000, files: [] };
  }
  state.issues = Array.isArray(data.issues) ? data.issues : [];
  state.currentIssueId = null;
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
  state.issues = [];
  state.currentIssueId = null;
  state.groupPrompt = '';
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
  app.classList.toggle('issues-collapsed', Boolean(state.collapsed.issues));
  const bs = $('#btnCollapseSessions');
  const bm = $('#btnCollapseMembers');
  const bi = $('#btnCollapseIssues');
  if (bs) bs.textContent = state.collapsed.sessions ? '⟩' : '⟨';
  if (bm) bm.textContent = state.collapsed.members ? '⟩' : '⟨';
  if (bi) bi.textContent = state.collapsed.issues ? '⟨' : '⟩';
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
  renderIssues();
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

  if (!state.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="big">开始群聊</div>
      <div class="sub">
        输入消息并发送。<br>
        用 <code>@名字</code> 点名某个成员，或 <code>@@名字</code> 私密点名。<br>
        不点名时，按当前调度模式处理。
      </div>`;
    box.appendChild(empty);
    return;
  }

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
      ${m.note ? `<div class="err">${escapeHtml(m.note)}</div>` : ''}
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
  if (state.currentIssueId) {
    const isu = state.issues.find((x) => x.id === state.currentIssueId);
    if (isu) sysParts.push(`【当前议题】${isu.title}\n要求：${isu.brief || '无'}\n验收标准：${isu.acceptance || '无'}\n围绕这个议题发言，不要扯到别的议题。`);
  }
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

  // 有些模型（Claude 系等）不支持 assistant prefill，要求对话必须以 user 结尾。
  // 同一成员连续发言、或最后一条正是该成员自己的回复时，这里会兜底补一条 user。
  const last = list[list.length - 1];
  if (!last || last.role !== 'user') {
    list.push({ role: 'user', content: '请继续。' });
  }
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
  await pauseGate();

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

  let watchdog = null;
  let stuck = false;
  const bumpWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stuck = true;
      try { bridge.abort(runId); } catch { /* 忽略 */ }
    }, watchdogMs());
  };
  bumpWatchdog();

  const offDelta = bridge.onDelta((d) => {
    if (d.runId !== runId) return;
    bumpWatchdog();
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
    clearTimeout(watchdog);
    offDelta();
    // rAF 节流可能还没落地最后一帧，结束后强制渲染一次
    if (msg.text) bubble.innerHTML = mdRender(msg.text);
    state.activeRuns.delete(runId);

    if (stuck) {
      msg.interrupted = true;
      msg.note = `超过 ${Math.round(watchdogMs() / 1000)} 秒没有收到任何数据，已自动中止。可以点「继续生成」重试。`;
    }
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

  // 防御：如果状态残留（例如上一次请求异常结束），先复位再继续
  if (state.running && (!state.activeRuns || state.activeRuns.size === 0)) {
    resetRunState();
  }

  state.running = true;
  state.stopRequested = false;
  state.paused = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;
  const bp = $('#btnPause');
  if (bp) { bp.hidden = false; bp.textContent = '暂停'; bp.classList.remove('paused'); }

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
  state.paused = false;
  state.activeRuns.forEach((id) => bridge.abort(id));
  const pause = $('#btnPause');
  if (pause) { pause.hidden = true; pause.textContent = '暂停'; pause.classList.remove('paused'); }
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
  if (state.messages.length === 1) {
    renderMessages();            // 首条消息：整体重绘，顺便清掉空状态占位
  } else {
    $('#messages').appendChild(messageNode(userMsg));
  }
  $('#input').value = '';
  autoTitle(userMsg.text);
  persistChat();

  state.running = true;
  state.stopRequested = false;
  state.paused = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;
  const bp = $('#btnPause');
  if (bp) { bp.hidden = false; bp.textContent = '暂停'; bp.classList.remove('paused'); }
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

    if (state.settings.mode === 'moderator' && state.issues.length) {
      await runIssueQueue(enabled, rounds);
    } else {
      await runDiscussion(state.settings.mode, rounds, enabled);
    }
  } catch (e) {
    pushSystem('出错：' + String(e.message || e));
  } finally {
    state.running = false;
    state.stopRequested = false;
    state.paused = false;
    state.currentSearchText = '';
    $('#btnSend').disabled = false;
    $('#btnStop').hidden = true;
    const bp = $('#btnPause');
    if (bp) { bp.hidden = true; bp.textContent = '暂停'; bp.classList.remove('paused'); }
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
  state.paused = false;
  $('#btnSend').disabled = true;
  $('#btnStop').hidden = false;
  const bp = $('#btnPause');
  if (bp) { bp.hidden = false; bp.textContent = '暂停'; bp.classList.remove('paused'); }
  try {
    if (state.settings.mode === 'moderator' && state.issues.length) {
      await runIssueQueue(enabled, 0);
    } else {
      await runDiscussion(state.settings.mode, 0, enabled);
    }
  } catch (e) {
    pushSystem('继续讨论出错：' + String(e.message || e));
  } finally {
    state.running = false;
    state.stopRequested = false;
    state.paused = false;
    $('#btnSend').disabled = false;
    $('#btnStop').hidden = true;
    const bp = $('#btnPause');
    if (bp) { bp.hidden = true; bp.textContent = '暂停'; bp.classList.remove('paused'); }
    persistChat();
  }
}

function pushSystem(text) {
  const m = { id: uid(), role: 'system', text, ts: Date.now() };
  state.messages.push(m);
  if (state.messages.length === 1) {
    renderMessages();
    persistChat();
    return;
  }
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
  if (!moderator || !moderator.model) { pushSystem('主持人没有配置模型'); return ''; }
  const names = enabled.map((m) => m.name);
  const unlimited = rounds === 0;
  let conclusion = '';

  const curIssue = state.currentIssueId ? state.issues.find((x) => x.id === state.currentIssueId) : null;
  const issueLine = curIssue
    ? `当前议题：「${curIssue.title}」\n要求：${curIssue.brief || '无'}\n验收标准：${curIssue.acceptance || '无'}`
    : '';

  pushSystem(
    `主持人：${moderator.name}${unlimited ? '（不限轮数，随时可点「停止」）' : `（最多 ${rounds} 次发言）`}`
  );

  const cap = safetyCap();
  let i = 0;
  while (!state.stopRequested && (unlimited || i < rounds) && i < cap) {
    const instruction = [
      '现在轮到你当主持人。',
      `可选成员：${names.join('、')}。`,
      issueLine,
      '请阅读群聊记录，决定下一个发言者，并给 TA 一句提示。',
      '如果你认为讨论已经充分、可以收尾了，就输出 {"done":true,"conclusion":"本议题的最终结论"} 来结束讨论；结论要具体、可执行。',
      '只输出一行 JSON，不要解释：{"next":"成员名","prompt":"提示"} 或 {"done":true,"conclusion":"结论"}',
    ].filter(Boolean).join('\n');

    const plan = parsePlan(await runSilent(moderator, instruction), names);

    if (plan.done) {
      conclusion = plan.conclusion || '';
      pushSystem(`主持人 ${moderator.name} 宣布讨论结束。${conclusion ? '\n\n结论：' + conclusion : ''}`);
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
  return conclusion;
}

function parsePlan(text, names) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no json');
    const obj = JSON.parse(m[0]);
    const next = String(obj.next || obj.name || '');
    // 主持人可以用 done:true 或 next:"结束" 来收尾
    const done = obj.done === true || /^(结束|停止|收尾|end|stop|finish)$/i.test(next);
    return { done, next, prompt: obj.prompt || obj.question || '', conclusion: obj.conclusion || obj.summary || '' };
  } catch {
    return { done: false, next: names[0] || '', prompt: '' };
  }
}

async function runSilent(member, extra) {
  const provider = providerOf(member);
  if (!provider) return '';
  await pauseGate();
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

/* ---------------- 策划组队 + 议题卡 ---------------- */

const PLANNER_SYSTEM = [
  '你是「智库」的审核方案策划者。用户会给你一段审核需求和资料，你要据此规划一个多成员审核团队，并拆解出待审核的议题卡。',
  '',
  '只输出一个 JSON 对象，不要输出任何解释、markdown 代码块或其它文字。JSON 结构必须严格如下：',
  '{',
  '  "team": [',
  '    {"name":"成员名","role":"分工一句话","persona":"完整的系统提示词","suggestedModel":"从可用模型列表里选一个","isModerator":false,"color":"#RRGGBB"}',
  '  ],',
  '  "issues": [',
  '    {"title":"议题标题","brief":"审核要求","acceptance":"验收标准"}',
  '  ]',
  '}',
  '',
  '规则：',
  '1. team 至少 2 人，最多 6 人；必须且只能有 1 个 isModerator 为 true 的成员（主持人），负责组织讨论、判断议题是否完成并给出结论。',
  '2. persona 要写清楚：审核范围、重点检查项、要给出什么证据、输出格式、如何与其他成员配合。',
  '3. suggestedModel 必须从「可用模型」列表里原样选取，不能编造；根据分工选择最合适的。',
  '4. issues 是把需求拆成的、可逐项审核的议题卡，每张卡的 brief 写清审什么，acceptance 写清怎样算通过。',
  '5. 所有文字用中文。',
].join('\n');

function plannerRef() {
  const pid = state.settings.plannerProviderId;
  const model = state.settings.plannerModel;
  const provider = state.providers.find((p) => p.id === pid) || state.providers[0];
  return { provider: provider || null, model: model || '' };
}

function availableModelList() {
  const out = [];
  for (const p of state.providers) {
    for (const m of (p.models || [])) out.push(`${p.name}：${m}`);
  }
  return out;
}

function parsePlanJson(text) {
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return null;
  const team = Array.isArray(obj.team) ? obj.team : (Array.isArray(obj.agents) ? obj.agents : []);
  const issues = Array.isArray(obj.issues) ? obj.issues : (Array.isArray(obj.topics) ? obj.topics : []);
  const normTeam = team.map((t) => ({
    name: String(t.name || '成员').slice(0, 30),
    role: String(t.role || t.responsibility || '').slice(0, 200),
    persona: String(t.persona || t.prompt || '').slice(0, 4000),
    suggestedModel: String(t.suggestedModel || t.model || '').split(/[：:]/).pop().trim(),
    isModerator: t.isModerator === true || /主持/.test(String(t.role || '')),
    color: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : null,
  }));
  const normIssues = issues.map((it) => ({
    title: String(it.title || it.name || '议题').slice(0, 120),
    brief: String(it.brief || it.requirement || it.desc || '').slice(0, 1000),
    acceptance: String(it.acceptance || it.criteria || '').slice(0, 1000),
  }));
  if (!normTeam.length && !normIssues.length) return null;
  return { team: normTeam, issues: normIssues };
}

const PALETTE = ['#5b8def', '#e06c5b', '#f5a623', '#46c2a3', '#9a6bd4', '#e08bc0'];

async function runPlanner(feedback) {
  const { provider, model } = plannerRef();
  if (!provider) { pushSystem('请先在设置里添加供应商并选择策划模型'); return false; }
  if (!model) { pushSystem('请先在设置里选择策划模型'); return false; }

  const requirement = ($('#planRequirement') ? $('#planRequirement').value : state.draftPlan.requirement).trim();
  if (!requirement && !state.draftPlan.team.length) { pushSystem('请先填写审核需求'); return false; }
  state.draftPlan.requirement = requirement;

  const models = availableModelList();
  const userParts = [requirement];

  // 读取知识库资料摘要，让策划模型了解待审核内容后再组队、拆议题
  if (typeof bridge.kbDigest === 'function' && state.kb.files && state.kb.files.length) {
    try {
      const d = await bridge.kbDigest({ files: state.kb.files });
      if (d && Array.isArray(d.files) && d.files.length) {
        const blocks = d.files.map((f) => {
          if (f.error) return `【文件：${f.name}】读取失败：${f.error}`;
          const mid = f.tail ? '\n……（中间略）……\n' + f.tail : '';
          return `【文件：${f.name}】（共 ${f.chars} 字）\n${f.head}${mid}`;
        });
        if (d.images && d.images.length) {
          blocks.push('【图片资料】' + d.images.map((i) => i.name).join('、'));
        }
        userParts.unshift('以下是待审核的资料内容摘要（据它规划审核团队和议题卡，不要假设资料里没有的内容）：\n\n' + blocks.join('\n\n'));
      }
    } catch (e) {
      pushSystem('读取知识库摘要失败：' + String(e.message || e));
    }
  }

  for (const fb of state.draftPlan.feedback) userParts.push('【上一版方案的修改意见】' + fb);
  if (feedback) userParts.push('【新的修改意见】' + feedback);
  const user = userParts.join('\n\n');

  const sys = models.length
    ? PLANNER_SYSTEM + '\n\n可用模型（只能从这里选 suggestedModel）：\n' + models.join('\n')
    : PLANNER_SYSTEM;

  $('#planStatus').textContent = '策划模型正在生成方案…';
  const res = await bridge.generatePlan({
    providerId: provider.id,
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    json: true,
    maxTokens: 0,
  });

  if (!res.ok) {
    $('#planStatus').textContent = '策划失败：' + String(res.error || '未知错误');
    return false;
  }
  const plan = parsePlanJson(res.text);
  if (!plan) {
    state.draftPlan.raw = res.text;
    $('#planStatus').textContent = '返回内容不是合法 JSON，无法解析。';
    renderPlanDraft();
    return false;
  }
  state.draftPlan.team = plan.team;
  state.draftPlan.issues = plan.issues;
  state.draftPlan.raw = '';
  if (feedback) state.draftPlan.feedback.push(feedback);
  $('#planStatus').textContent = `已生成：${plan.team.length} 名成员、${plan.issues.length} 张议题卡。可在下面继续提意见。`;
  renderPlanDraft();
  return true;
}

function resolveProviderForModel(rawModelName) {
  const modelName = String(rawModelName || '').split(/[：:]/).pop().trim();
  if (!modelName) return { providerId: null, model: '' };
  // 精确匹配
  for (const p of state.providers) {
    if ((p.models || []).includes(modelName)) return { providerId: p.id, model: modelName };
  }
  // 模糊匹配：模型名前缀相同（如 gemini-3.8-flash → gemini）
  const prefix = String(modelName).split('-')[0].toLowerCase();
  for (const p of state.providers) {
    const hit = (p.models || []).find((m) => String(m).toLowerCase().startsWith(prefix + '-'));
    if (hit) return { providerId: p.id, model: hit };
  }
  // 找不到：返回 null，让用户在成员编辑器里手动选，不乱配
  return { providerId: null, model: modelName };
}

/** 检查模型是否属于该供应商 */
function modelBelongsToProvider(providerId, rawModelName) {
  const modelName = String(rawModelName || '').split(/[：:]/).pop().trim();
  const p = state.providers.find((x) => x.id === providerId);
  return !!(p && (p.models || []).includes(modelName));
}

function renderPlanDraft() {
  const box = $('#planDraft');
  if (!box) return;
  const team = state.draftPlan.team || [];
  const issues = state.draftPlan.issues || [];
  if (!team.length && !issues.length) {
    box.innerHTML = state.draftPlan.raw
      ? `<div class="muted">模型返回了无法解析的内容：</div><pre class="raw">${escapeHtml(state.draftPlan.raw)}</pre>`
      : '<div class="muted">填写需求后点「生成方案」。</div>';
    return;
  }
  const teamHtml = team.map((t, i) => `
    <div class="plan-row">
      <span class="dot" style="background:${escapeHtml(t.color || PALETTE[i % PALETTE.length])}">${escapeHtml(initials(t.name))}</span>
      <div class="plan-meta">
        <div class="name">${escapeHtml(t.name)}${t.isModerator ? ' <span class="pill">主持人</span>' : ''} <span class="muted">· ${escapeHtml(t.suggestedModel || '未指定模型')}</span></div>
        <div class="muted">${escapeHtml(t.role || '')}</div>
      </div>
    </div>`).join('');
  const issueHtml = issues.map((it, i) => `
    <div class="plan-issue">
      <div class="name">${i + 1}. ${escapeHtml(it.title)}</div>
      <div class="muted">${escapeHtml(it.brief || '')}</div>
    </div>`).join('');
  box.innerHTML = `
    <div class="plan-sec"><div class="plan-sec-h">团队（${team.length} 人）</div>${teamHtml}</div>
    <div class="plan-sec"><div class="plan-sec-h">议题卡（${issues.length} 张）</div>${issueHtml}</div>`;
}

async function applyPlan() {
  const team = state.draftPlan.team || [];
  const issues = state.draftPlan.issues || [];
  if (!team.length) { pushSystem('方案里没有成员，无法应用'); return; }

  const members = team.map((t, i) => {
    const r = resolveProviderForModel(t.suggestedModel);
    return {
      id: uid(),
      name: t.name || ('成员' + (i + 1)),
      providerId: r.providerId,
      model: r.model,
      persona: t.persona || t.role || '',
      temp: 0.7,
      maxTokens: 0,
      reasoning: 'off',
      supportsImages: false,
      color: t.color || PALETTE[i % PALETTE.length],
      enabled: true,
      isModerator: t.isModerator === true,
    };
  });

  state.members = members;
  state.issues = issues.map((it) => ({
    id: uid(), title: it.title || '议题', brief: it.brief || '', acceptance: it.acceptance || '',
    status: 'todo', conclusion: '',
  }));
  state.currentIssueId = null;

  const mod = members.find((m) => m.isModerator) || members[members.length - 1];
  state.settings.mode = 'moderator';
  state.settings.moderatorId = mod.id;

  $('#modalPlan').hidden = true;
  persistConfig();
  saveKbToSession();
  renderAll();
  pushSystem(`已创建审核团队（${members.length} 人）和 ${state.issues.length} 张议题卡。主持人：${mod.name}。发送消息后开始逐卡审核。`);
}

function openPlanModal() {
  if (!state.providers.length) { openSettings(); return; }
  if (!$('#planRequirement').value.trim()) {
    $('#planRequirement').value = state.draftPlan.requirement || '';
  }
  $('#planStatus').textContent = state.draftPlan.team.length ? '已有方案草稿，可继续提意见或重新生成。' : '';
  updatePlanKbHint();
  renderPlanDraft();
  $('#modalPlan').hidden = false;
}

function updatePlanKbHint() {
  const el = $('#planKbHint');
  if (!el) return;
  const files = state.kb.files || [];
  if (!files.length) {
    el.textContent = '知识库为空：可以先添加文件，策划会读取文件内容来组队、拆议题。';
    return;
  }
  const docs = files.filter((f) => f.kind !== 'image');
  const imgs = files.filter((f) => f.kind === 'image');
  const chars = docs.reduce((a, f) => a + (Number(f.chars) || 0), 0);
  let s = `知识库：${docs.length} 份文档（约 ${fmtNum(chars)} 字）`;
  if (imgs.length) s += `、${imgs.length} 张图片`;
  s += '。策划组队时会读取这些内容。';
  el.textContent = s;
}

function renderPlannerSelect() {
  const pp = $('#plannerProvider');
  const pm = $('#plannerModel');
  if (!pp || !pm) return;

  pp.innerHTML = state.providers
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');
  const curPid = state.settings.plannerProviderId || (state.providers[0] ? state.providers[0].id : '');
  pp.value = curPid;

  const fillModels = () => {
    const p = state.providers.find((x) => x.id === pp.value);
    const models = (p && Array.isArray(p.models)) ? p.models.slice() : [];
    const cur = state.settings.plannerModel;
    if (cur && !models.includes(cur)) models.unshift(cur);
    pm.innerHTML = models.length
      ? models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
      : '<option value="">（先拉取模型）</option>';
    pm.value = cur && models.includes(cur) ? cur : (models[0] || '');
  };
  pp.onchange = () => { fillModels(); };
  fillModels();
}

/* ---------------- 议题卡 ---------------- */

function renderIssues() {
  const box = $('#issueList');
  const count = $('#issueCount');
  if (!box) return;
  if (count) count.textContent = state.issues.length;
  box.innerHTML = '';
  if (!state.issues.length) {
    box.innerHTML = '<div class="muted" style="padding:8px">还没有议题卡。点「策划组队」自动生成，或「+ 添加」手动创建。</div>';
    return;
  }
  for (const it of state.issues) {
    const statusCls = it.status === 'done' ? 'done' : (it.status === 'active' ? 'active' : (it.status === 'skipped' ? 'skipped' : 'todo'));
    const statusTxt = { todo: '未审核', active: '审核中', done: '已审核', skipped: '已跳过' }[statusCls] || statusCls;
    const row = document.createElement('div');
    row.className = 'issue status-' + statusCls + (it.collapsed ? ' collapsed' : '');

    const head = document.createElement('div');
    head.className = 'issue-head';
    head.innerHTML = `
      <span class="pill status-${statusCls}">${statusTxt}</span>
      <span class="name" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</span>
      <button class="issue-edit" title="编辑议题">✎</button>`;
    row.appendChild(head);

    if (!it.collapsed) {
      if (it.brief) {
        const b = document.createElement('div');
        b.className = 'muted';
        b.textContent = it.brief;
        row.appendChild(b);
      }
      if (it.conclusion) {
        const c = document.createElement('div');
        c.className = 'conclusion';
        c.textContent = '结论：' + it.conclusion;
        row.appendChild(c);
      }
    }

    row.onclick = (e) => {
      if (e.target.closest('.issue-edit')) return;
      it.collapsed = !it.collapsed;
      renderIssues();
      saveKbToSession();
    };
    head.querySelector('.issue-edit').onclick = (e) => {
      e.stopPropagation();
      openIssueEditor(it.id);
    };
    box.appendChild(row);
  }
}

function openIssueEditor(id) {
  const it = state.issues.find((x) => x.id === id);
  if (!it) { renderIssues(); return; }
  $('#issueEditId').value = it.id;
  $('#issueTitle').value = it.title;
  $('#issueBrief').value = it.brief || '';
  $('#issueAcceptance').value = it.acceptance || '';
  $('#modalIssue').hidden = false;
}

function saveIssueEditor() {
  const id = $('#issueEditId').value;
  const title = $('#issueTitle').value.trim() || '议题';
  const brief = $('#issueBrief').value.trim();
  const acceptance = $('#issueAcceptance').value.trim();
  if (id) {
    const it = state.issues.find((x) => x.id === id);
    if (it) { it.title = title; it.brief = brief; it.acceptance = acceptance; }
  } else {
    state.issues.push({ id: uid(), title, brief, acceptance, status: 'todo', conclusion: '' });
  }
  $('#modalIssue').hidden = true;
  renderIssues();
  saveKbToSession();
}

async function runIssueQueue(enabled, rounds) {
  const todo = state.issues.filter((i) => i.status === 'todo' || i.status === 'active');
  if (!todo.length) { pushSystem('没有待审核的议题。'); return; }
  for (const issue of todo) {
    if (state.stopRequested) break;
    issue.status = 'active';
    state.currentIssueId = issue.id;
    renderIssues();
    pushSystem(`━━ 开始审核议题：${issue.title} ━━`);
    const conclusion = await runModerated(rounds, enabled);
    issue.conclusion = conclusion || '';
    issue.status = 'done';
    state.currentIssueId = null;
    renderIssues();
    persistChat();
    if (issue.conclusion) pushSystem(`✅ 议题完成：${issue.title}\n\n结论：${issue.conclusion}`);
    else pushSystem(`✅ 议题完成：${issue.title}（无结论）`);
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

async function fetchAllModels() {
  const btn = $('#btnFetchAllModels');
  if (!btn || btn.disabled) return;
  if (!state.providers.length) { pushSystem('还没有供应商，请先添加。'); return; }

  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    // 先把当前 DOM（含新填的 Key）落盘
    const providers = collectProvidersFromDom();
    await bridge.saveConfig({ providers, proxy: $('#proxy').value.trim() });
    const cfg = await bridge.getConfig();
    state.providers = cfg.providers;

    let ok = 0;
    const fails = [];
    for (const p of state.providers) {
      const card = document.querySelector(`.provider[data-id="${p.id}"]`);
      const status = card && card.querySelector('[data-role="status"]');
      if (status) status.textContent = '拉取中…';
      try {
        const models = await bridge.listModels(p.id);
        p.models = Array.isArray(models) ? models : [];
        ok++;
        if (status) status.textContent = `共 ${models.length} 个模型`;
      } catch (e) {
        const msg = String(e.message || e).slice(0, 60);
        if (status) status.textContent = '失败：' + msg;
        fails.push(`${p.name}：${msg}`);
      }
    }

    // 保存拉取到的模型列表
    await bridge.saveConfig({
      providers: state.providers.map((pp) => ({ id: pp.id, name: pp.name, baseUrl: pp.baseUrl, models: pp.models })),
      proxy: $('#proxy').value.trim(),
    });
    renderProviders();
    renderPlannerSelect();

    const total = state.providers.reduce((a, pp) => a + (pp.models || []).length, 0);
    if (fails.length) {
      pushSystem(`拉取完成：成功 ${ok}/${state.providers.length} 家，共 ${total} 个模型。\n失败：${fails.join('；')}`);
    } else {
      pushSystem(`已拉取全部 ${ok} 家供应商的模型，共 ${total} 个模型。`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 一键拉取全部模型';
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

  sel.onchange = () => { renderModelOptions(sel.value, ''); updateMemberModelWarning(); };
  $('#mModelSelect').onchange = () => {
    $('#mModelCustom').hidden = $('#mModelSelect').value !== CUSTOM_MODEL;
    updateMemberModelWarning();
  };
  $('#mModelCustom').addEventListener('input', updateMemberModelWarning);

  $('#btnDeleteMember').style.display = m ? '' : 'none';
  updateMemberModelWarning();
  $('#modalMember').hidden = false;
}

function updateMemberModelWarning() {
  const el = $('#memberModelWarn');
  if (!el) return;
  const pid = $('#mProvider').value;
  const modelSel = $('#mModelSelect');
  const custom = $('#mModelCustom');
  const model = (modelSel.value === '__custom__') ? custom.value.trim() : modelSel.value;
  if (!model || !pid) { el.textContent = ''; el.hidden = true; return; }
  const belongs = modelBelongsToProvider(pid, model);
  if (belongs) {
    el.textContent = '';
    el.hidden = true;
  } else {
    el.textContent = `⚠ 模型「${model}」不在当前供应商的模型列表里，请更换供应商或模型`;
    el.hidden = false;
  }
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
  $('#btnPause').onclick = togglePause;
  $('#btnClearKb').onclick = async () => {
    if (!state.kb.files.length) { pushSystem('知识库已经是空的。'); return; }
    const ok = await askUser({
      title: '清空知识库',
      message: `移除当前会话的全部 ${state.kb.files.length} 份资料？解析缓存也会一并清理。`,
      danger: true,
      okText: '清空',
    });
    if (!ok) return;
    state.kb.files = [];
    state.kbCache.clear();
    renderKbList();
    saveKbToSession();
    pushSystem('已清空知识库。');
  };
  $('#allReasoning').onchange = (e) => setAllReasoning(e.target.checked);
  $('#allVision').onchange = (e) => setAllVision(e.target.checked);
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
  bindContextMenu();
  $('#btnKb').onclick = openKb;
  $('#btnGroupPrompt').onclick = openGroupPrompt;
  $('#btnCancelGroupPrompt').onclick = () => { $('#modalGroupPrompt').hidden = true; };
  $('#btnSaveGroupPrompt').onclick = saveGroupPrompt;
  $('#btnPlan').onclick = openPlanModal;
  $('#btnPlanGenerate').onclick = () => runPlanner(null);
  $('#btnPlanRegenerate').onclick = () => runPlanner($('#planFeedback').value.trim());
  $('#btnPlanApply').onclick = applyPlan;
  $('#btnPlanClose').onclick = () => { $('#modalPlan').hidden = true; };
  $('#btnAddIssue').onclick = () => {
    $('#issueEditId').value = ''; $('#issueTitle').value = ''; $('#issueBrief').value = ''; $('#issueAcceptance').value = '';
    $('#modalIssue').hidden = false;
  };
  $('#btnCloseIssue').onclick = () => { $('#modalIssue').hidden = true; };
  $('#btnSaveIssue').onclick = saveIssueEditor;
  $('#btnDeleteIssue').onclick = () => {
    const id = $('#issueEditId').value;
    if (id) { state.issues = state.issues.filter((x) => x.id !== id); renderIssues(); saveKbToSession(); }
    $('#modalIssue').hidden = true;
  };
  $('#btnCollapseIssues').onclick = () => toggleCollapse('issues');

  $('#btnCloseKb').onclick = () => { $('#modalKb').hidden = true; };
  const clearCacheBtn = $('#btnClearKbCache');
  if (clearCacheBtn) {
    clearCacheBtn.hidden = typeof bridge.kbClearCache !== 'function';
    clearCacheBtn.onclick = async () => {
      const ok = await askUser({ title: '清理解析缓存', message: '会删除已解析的资料文本缓存，之后需要重新添加文件才能再检索。', okText: '清理' });
      if (!ok) return;
      try {
        const r = await bridge.kbClearCache();
        state.kbCache.clear();
        pushSystem(`已清理 ${r.removed} 个解析缓存文件。`);
        await refreshKbCacheInfo();
      } catch (e) {
        pushSystem('清理失败：' + String(e.message || e));
      }
    };
  }
  $('#kbBudget').onchange = () => {
    state.kb.budget = Math.max(1000, Number($('#kbBudget').value) || 12000);
    state.kbCache.clear();
    saveKbToSession();
  };
  $('#btnNewSession').onclick = newSession;
  $('#btnCollapseSessions').onclick = () => toggleCollapse('sessions');
  $('#btnCollapseMembers').onclick = () => toggleCollapse('members');
  $('#btnCloseSettings').onclick = () => { $('#modalSettings').hidden = true; };
  $('#btnAddProvider').onclick = addProvider;
  $('#btnFetchAllModels').onclick = fetchAllModels;

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
    state.kb.enabled = $('#kbEnabled').checked;
    state.kbCache.clear();
    renderKbList();
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
    state.settings.plannerProviderId = $('#plannerProvider').value || null;
    state.settings.plannerModel = $('#plannerModel').value || null;
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
    resetRunState();              // 关键：先中止在跑的请求，否则会一直卡在 running
    state.messages = [];
    try { await bridge.clearChat(); } catch { /* 忽略 */ }
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
      groupPrompt: state.groupPrompt,
      issues: state.issues,
    });
  }
  persistConfig();
}

function renderKbList() {
  const btn = $('#btnKb');
  if (btn) {
    const n = (state.kb.files || []).length;
    btn.textContent = state.kb.enabled === false ? '📚 知识库(关)' : `📚 知识库${n ? '(' + n + ')' : ''}`;
  }
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

/* 右键菜单 + 关于信息（注入 app.js 的函数块） */

/* ---------- 右键菜单 ---------- */
/* ---------- 运行状态复位 ---------- */
// 超过该时长没有任何数据就判定卡死；运行时读取，便于测试时覆盖
function watchdogMs() {
  const v = (typeof window !== 'undefined' && Number(window.__RUN_WATCHDOG_MS)) || 0;
  return v > 0 ? v : 120000;
}

function resetRunState() {
  for (const runId of Array.from(state.activeRuns || [])) {
    try { bridge.abort(runId); } catch { /* 忽略 */ }
  }
  if (state.activeRuns && state.activeRuns.clear) state.activeRuns.clear();
  state.running = false;
  state.stopRequested = false;
  state.paused = false;
  const send = $('#btnSend');
  if (send) send.disabled = false;
  const stop = $('#btnStop');
  if (stop) stop.hidden = true;
  const pause = $('#btnPause');
  if (pause) { pause.hidden = true; pause.textContent = '暂停'; pause.classList.remove('paused'); }
}

function pauseSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 暂停闸门：暂停时不发起新的模型请求，但保留当前请求跑完 */
async function pauseGate() {
  while (state.paused && !state.stopRequested && state.running) {
    await pauseSleep(150);
  }
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  updatePauseButton();
  pushSystem(state.paused ? '已暂停：当前这条说完后停住，点「继续」恢复。' : '已继续。');
}

function updatePauseButton() {
  const b = $('#btnPause');
  if (!b) return;
  b.textContent = state.paused ? '继续' : '暂停';
  b.classList.toggle('paused', state.paused);
}

function closeCtxMenu() {
  const m = document.querySelector('.ctx-menu');
  if (m) m.remove();
}

function showWebContextMenu(e, { editable, el, hasSelection }) {
  closeCtxMenu();
  const items = [];

  if (editable) items.push(['剪切', () => document.execCommand('cut')]);
  if (editable || hasSelection) items.push(['复制', () => document.execCommand('copy')]);
  if (editable) items.push(['粘贴', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      el.focus();
      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        const start = el.selectionStart == null ? el.value.length : el.selectionStart;
        const end = el.selectionEnd == null ? start : el.selectionEnd;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + text.length;
      }
    } catch {
      pushSystem('浏览器不允许直接读取剪贴板，请用 Ctrl+V 粘贴。');
    }
  }]);
  items.push(['全选', () => {
    if (el && el.select) { el.focus(); el.select(); } else document.execCommand('selectAll');
  }]);

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => { closeCtxMenu(); fn(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  const pad = 6;
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width + pad > window.innerWidth) x = window.innerWidth - rect.width - pad;
  if (y + rect.height + pad > window.innerHeight) y = window.innerHeight - rect.height - pad;
  menu.style.left = Math.max(pad, x) + 'px';
  menu.style.top = Math.max(pad, y) + 'px';
}

function bindContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target;
    const editable = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    const sel = window.getSelection();
    const hasSelection = !!(sel && String(sel).length > 0);
    if (!editable && !hasSelection) return;

    e.preventDefault();
    if (typeof bridge.showContextMenu === 'function') {
      bridge.showContextMenu({ editable, hasSelection });
    } else {
      showWebContextMenu(e, { editable, el, hasSelection });
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ctx-menu')) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });
  window.addEventListener('blur', closeCtxMenu);
}

/* ---------- 关于信息 ---------- */
let appInfoCache = null;

async function loadAppInfo() {
  try {
    appInfoCache = typeof bridge.appInfo === 'function'
      ? await bridge.appInfo()
      : { version: '—', engine: '', releases: 'https://github.com/Thams94/ai-group-chat/releases/latest' };
  } catch {
    appInfoCache = { version: '—', engine: '', releases: '' };
  }

  const v = $('#appVersion');
  if (v) v.textContent = appInfoCache.version || '—';

  const eng = $('#engineVersion');
  if (eng) {
    const label = appInfoCache.electron ? `Electron ${appInfoCache.electron}` : (appInfoCache.engine || '');
    eng.textContent = label ? '· ' + label : '';
  }

  const link = $('#linkUpdate');
  if (link) {
    link.onclick = (e) => {
      e.preventDefault();
      if (!appInfoCache.releases) return;
      if (typeof bridge.openExternal === 'function') bridge.openExternal(appInfoCache.releases);
      else window.open(appInfoCache.releases, '_blank', 'noopener');
    };
  }

  const row = $('#dataDirRow');
  const dirPath = $('#dataDirPath');
  const openBtn = $('#btnOpenDataDir');
  if (row && dirPath) {
    if (appInfoCache.dataDir) {
      row.hidden = false;
      dirPath.textContent = appInfoCache.dataDir;
      dirPath.title = appInfoCache.dataDir;
      if (openBtn) openBtn.onclick = () => bridge.openPath(appInfoCache.dataDir);
    } else {
      row.hidden = true;
    }
  }
}

function openGroupPrompt() {
  $('#groupPrompt').value = state.groupPrompt || '';
  $('#modalGroupPrompt').hidden = false;
  $('#groupPrompt').focus();
}

function saveGroupPrompt() {
  state.groupPrompt = $('#groupPrompt').value;
  $('#modalGroupPrompt').hidden = true;
  saveKbToSession();          // 复用：把会话内容整体落盘（含成员/知识库/提示词）
  pushSystem(state.groupPrompt ? '已更新当前会话的群组提示词。' : '已清空当前会话的群组提示词。');
}

async function openKb() {
  $('#kbEnabled').checked = state.kb.enabled !== false;
  $('#kbBudget').value = state.kb.budget || 12000;
  renderKbList();
  $('#modalKb').hidden = false;
  await refreshKbCacheInfo();
}

async function refreshKbCacheInfo() {
  const el = $('#kbCacheInfo');
  if (!el || typeof bridge.kbCacheInfo !== 'function') return;
  try {
    const info = await bridge.kbCacheInfo();
    el.textContent = `解析缓存：${info.count} 个文件，${(info.bytes / 1024).toFixed(0)} KB`;
  } catch {
    el.textContent = '解析缓存：不可用';
  }
}

function openSettings() {
  $('#modalMember').hidden = true;
  $('#proxy').value = state.proxy || '';
  $('#safetyCap').value = safetyCap();
  renderProviders();
  renderPlannerSelect();
  syncBatchChecks();
  loadAppInfo();
  $('#modalSettings').hidden = false;
}

function syncBatchChecks() {
  const members = state.members || [];
  const allHigh = members.length > 0 && members.every((m) => (m.reasoning || 'off') === 'high');
  const allVision = members.length > 0 && members.every((m) => m.supportsImages === true);
  const r = $('#allReasoning');
  const v = $('#allVision');
  if (r) r.checked = allHigh;
  if (v) v.checked = allVision;
}

function setAllReasoning(on) {
  if (!state.members.length) { pushSystem('还没有成员'); return; }
  for (const m of state.members) m.reasoning = on ? 'high' : 'off';
  persistConfig();
  renderAll();
  syncBatchChecks();
  pushSystem(on ? '已为所有成员开启高思考模式。' : '已关闭所有成员的思考模式。');
}

function setAllVision(on) {
  if (!state.members.length) { pushSystem('还没有成员'); return; }
  for (const m of state.members) m.supportsImages = on;
  persistConfig();
  renderAll();
  syncBatchChecks();
  pushSystem(on ? '已为所有成员开启看图模式。' : '已关闭所有成员的看图模式。');
}

/* ---------------- 导出 ---------------- */

function buildMarkdown() {
  const lines = ['# 智库记录', '', `导出时间：${new Date().toLocaleString()}`, ''];
  for (const m of state.messages) {
    if (m.role === 'system') { lines.push(`> ${m.text}`, ''); continue; }
    const member = state.members.find((x) => x.id === m.memberId);
    const who = m.role === 'user' ? '我' : (member ? member.name : '未知成员');
    const tag = m.visibility === 'private' ? '（私密）' : '';
    const u = usageOf(m);
    const tokens = u ? ` · ${u.total} tokens` : '';
    lines.push(`**${who}**${tag}${tokens}`, '', m.text || '', '');
  }

  if (state.issues && state.issues.length) {
    lines.push('', '---', '', '# 议题卡', '');
    for (const it of state.issues) {
      const mark = it.status === 'done' ? '✅' : (it.status === 'active' ? '🔍' : '⏳');
      lines.push(`## ${mark} ${it.title}`, '');
      if (it.brief) lines.push(`- 要求：${it.brief}`);
      if (it.acceptance) lines.push(`- 验收标准：${it.acceptance}`);
      if (it.conclusion) lines.push(`- 结论：${it.conclusion}`);
      lines.push('');
    }
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
