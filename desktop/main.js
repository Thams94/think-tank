'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu, net, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// 数据目录固定为 %APPDATA%/think-tank，
// 否则打包后应用名变化会指向另一个目录，看起来像"配置丢了"。
// 旧版目录 %APPDATA%/ai-group-chat 会在首次启动时复制过来（旧目录保留作备份）。
// THINKTANK_USER_DIR（兼容旧的 AIGC_USER_DIR）仅用于测试隔离。
const APP_DATA_DIR = path.join(app.getPath('appData'), 'think-tank');
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'ai-group-chat');
const DATA_DIR_OVERRIDE = process.env.THINKTANK_USER_DIR || process.env.AIGC_USER_DIR;

if (DATA_DIR_OVERRIDE) {
  app.setPath('userData', DATA_DIR_OVERRIDE);
} else {
  try {
    if (!fs.existsSync(APP_DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
      fs.cpSync(LEGACY_DATA_DIR, APP_DATA_DIR, { recursive: true });
    }
  } catch { /* 迁移失败就用新目录，不阻塞启动 */ }
  app.setPath('userData', APP_DATA_DIR);
}

const USER_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DIR, 'config.json');
const CHAT_FILE = path.join(USER_DIR, 'chats.json');       // 旧版单会话文件（迁移用）
const SESSIONS_FILE = path.join(USER_DIR, 'sessions.json'); // 会话索引
const SESSIONS_DIR = path.join(USER_DIR, 'sessions');       // 每个会话一个文件
const KB_CACHE_DIR = path.join(USER_DIR, 'kb-cache');       // 知识库解析结果缓存

let win = null;
const running = new Map(); // runId -> AbortController

/* ---------------- 通用 ---------------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 统一 HTTP 出口。
 * Node 的全局 fetch 不认系统代理，需要代理的网络下会直接超时；
 * 优先用 Electron 的 net.fetch（Chromium 网络栈，遵循系统代理）。
 */
async function httpFetch(url, opts = {}) {
  if (net && typeof net.fetch === 'function') {
    return net.fetch(url, opts);
  }
  return fetch(url, opts);
}

function applyProxy(cfg) {
  const rules = (cfg && cfg.proxy ? String(cfg.proxy) : '').trim();
  try {
    if (rules) {
      session.defaultSession.setProxy({ proxyRules: rules });
    } else {
      session.defaultSession.setProxy({ mode: 'system' });
    }
  } catch (e) {
    console.warn('设置代理失败:', e.message);
  }
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------------- 加密 ---------------- */

function encryptKey(key) {
  if (!key) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'dpapi:' + safeStorage.encryptString(key).toString('base64');
    }
  } catch (e) {
    console.warn('系统加密不可用，退回 base64:', e.message);
  }
  return 'plain:' + Buffer.from(key, 'utf8').toString('base64');
}

function decryptKey(enc) {
  if (!enc) return '';
  try {
    if (enc.startsWith('dpapi:')) {
      return safeStorage.decryptString(Buffer.from(enc.slice(6), 'base64'));
    }
    if (enc.startsWith('plain:')) {
      return Buffer.from(enc.slice(6), 'base64').toString('utf8');
    }
    // 兼容旧格式（纯 base64，无前缀）
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        /* 落到下面的 base64 兜底 */
      }
    }
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch (e) {
    console.warn('解密失败:', e.message);
    return '';
  }
}

/* ---------------- 配置 ---------------- */

function normalizeProvider(p) {
  return {
    id: p.id || newId(),
    name: p.name || '未命名供应商',
    baseUrl: p.baseUrl || '',
    apiKeyEnc: p.apiKeyEnc || '',
    models: Array.isArray(p.models) ? p.models : [],
  };
}

/**
 * 读取配置，并做一次迁移：
 * 旧版只有顶层 baseUrl / apiKeyEnc，没有 providers —— 自动转成一个"默认"供应商，
 * 并把没有 providerId 的成员挂到它下面。
 */
function loadConfig() {
  const raw = readJson(CONFIG_FILE, {});

  let providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : [];

  const legacyUrl = raw.baseUrl || '';
  const legacyKey = raw.apiKeyEnc || '';
  if (!providers.length && (legacyUrl || legacyKey)) {
    providers = [normalizeProvider({
      id: 'p-default',
      name: '默认',
      baseUrl: legacyUrl,
      apiKeyEnc: legacyKey,
    })];
  }

  const fallbackId = providers[0] ? providers[0].id : null;

  let members = Array.isArray(raw.members) ? raw.members : [];
  members = members.map((m) => ({
    id: m.id || newId(),
    name: m.name || '成员',
    providerId: m.providerId || fallbackId,
    model: m.model || '',
    persona: m.persona || '',
    temp: typeof m.temp === 'number' ? m.temp : 0.7,
    color: m.color || '#5b8def',
    maxTokens: Number(m.maxTokens) || 0,
    reasoning: m.reasoning || 'off',
    supportsImages: Boolean(m.supportsImages),
    enabled: m.enabled !== false,
  }));

  return {
    providers,
    proxy: raw.proxy || '',
    groupPrompt: raw.groupPrompt || '',
    kb: raw.kb || { enabled: true, budget: 12000, files: [] },
    members,
    settings: raw.settings || { mode: 'manual', rounds: 1, moderatorId: null },
  };
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

function getProvider(cfg, providerId) {
  const list = cfg.providers || [];
  return list.find((p) => p.id === providerId) || list[0] || null;
}

function normalizeBase(baseUrl) {
  let b = String(baseUrl || '').trim();
  if (!b) throw new Error('供应商还没填 API 地址');
  b = b.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b;
}

/* ---------------- OpenAI 兼容 ---------------- */

async function listModels(cfg, providerId, keyOverride) {
  const provider = getProvider(cfg, providerId);
  if (!provider) throw new Error('还没有配置供应商');
  const base = normalizeBase(provider.baseUrl);
  const key = keyOverride || decryptKey(provider.apiKeyEnc);

  const res = await httpFetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const items = data.data || data.models || [];
  return items
    .map((m) => {
      if (typeof m === 'string') return m.trim();
      const id = m.id ? String(m.id).trim() : '';
      const name = m.name ? String(m.name).trim() : '';
      const display = m.display_name ? String(m.display_name).trim() : '';
      // id 看起来像模型名（字母开头）就用 id；否则优先 name
      if (id && /^[a-zA-Z][\w.\-+]*$/.test(id)) return id;
      return name || display || id;
    })
    .filter(Boolean)
    .sort();
}

async function streamChat({ baseUrl, apiKey, model, messages, temperature, signal, onDelta, maxTokens, reasoning }) {
  const base = normalizeBase(baseUrl);
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },   // 让服务端在末尾回传 token 用量
    temperature: typeof temperature === 'number' ? temperature : 0.7,
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  // 思考强度：OpenAI 兼容的 reasoning_effort
  const wantReasoning = reasoning && reasoning !== 'off' ? String(reasoning) : null;
  if (wantReasoning) body.reasoning_effort = wantReasoning;

  const res = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let text = await res.text();
    // 服务端不认 reasoning_effort：去掉后重试一次（部分中转站会直接 400）
    if (body.reasoning_effort && /reasoning|thinking|unsupported|unknown|invalid/i.test(text)) {
      const retryBody = { ...body };
      delete retryBody.reasoning_effort;
      const retry = await httpFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(retryBody),
        signal,
      });
      if (retry.ok) {
        appendDiag({ kind: 'reasoning-fallback', model, status: res.status });
        return readStream(retry, onDelta);
      }
      text = await retry.text();
    }
    throw new Error(`HTTP ${res.status}：${text.slice(0, 500)}`);
  }

  return readStream(res, onDelta);
}

/** 解析 SSE 流（供正常请求与重试共用） */
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let usage = null;
  let finishReason = null;
  let sawDone = false;
  let reasoningChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }

  // 流结束时最后一条可能没有换行结尾，补处理一次，避免丢内容或丢 usage
  if (buffer.trim()) handleLine(buffer.trim());
  buffer = '';

  function handleLine(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') sawDone = true;
      return;
    }
    try {
      const json = JSON.parse(payload);
      if (json.usage) {
        usage = json.usage;
        onDelta({ type: 'usage', usage: json.usage });
      }
      const choice = json.choices?.[0];
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (delta.reasoning_content) {
        reasoningChars += delta.reasoning_content.length;
        onDelta({ type: 'reasoning', text: delta.reasoning_content });
      }
      if (delta.content) {
        full += delta.content;
        onDelta({ type: 'content', text: delta.content });
      }
    } catch {
      /* 忽略解析失败的行 */
    }
  }
  // 没收到 finish_reason 且没收到 [DONE]，说明流被中途掐断了
  const truncated = finishReason === 'length';
  const interrupted = !sawDone && !finishReason;
  return { text: full, usage, finishReason, sawDone, truncated, interrupted, reasoningChars };
}

/** 非流式单次补全（供策划模型用，支持 JSON 结构化输出） */
async function completeChat({ baseUrl, apiKey, model, messages, temperature, maxTokens, reasoning, json }) {
  const base = normalizeBase(baseUrl);
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.3,
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;
  const wantReasoning = reasoning && reasoning !== 'off' ? String(reasoning) : null;
  if (wantReasoning) body.reasoning_effort = wantReasoning;
  if (json) body.response_format = { type: 'json_object' };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  let res = await httpFetch(`${base}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  // 服务端不认 response_format / reasoning_effort：去掉后重试一次
  if (!res.ok) {
    let text = await res.text();
    let retryBody = { ...body };
    let shouldRetry = false;
    if (body.response_format && /response_format|json_object|unsupported|invalid|unknown/i.test(text)) {
      delete retryBody.response_format;
      shouldRetry = true;
    }
    if (!shouldRetry && retryBody.reasoning_effort && /reasoning|thinking|unsupported|invalid|unknown/i.test(text)) {
      delete retryBody.reasoning_effort;
      shouldRetry = true;
    }
    if (shouldRetry) {
      const r2 = await httpFetch(`${base}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(retryBody),
      });
      if (r2.ok) {
        appendDiag({ kind: 'complete-retry', model });
        res = r2;
      } else {
        text = await r2.text();
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0] || {};
  return {
    text: choice.message?.content || '',
    usage: data.usage || null,
    finishReason: choice.finish_reason || null,
  };
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: '智库',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(USER_DIR) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- IPC ---------------- */

ipcMain.handle('config:get', () => {
  const cfg = loadConfig();
  return {
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      hasKey: Boolean(p.apiKeyEnc),
      models: p.models,
    })),
    proxy: cfg.proxy,
    groupPrompt: cfg.groupPrompt,
    kb: cfg.kb,
    members: cfg.members,
    settings: cfg.settings,
  };
});

ipcMain.handle('config:save', (_e, patch) => {
  const cfg = loadConfig();

  if (typeof patch.proxy === 'string') cfg.proxy = patch.proxy.trim();
  if (typeof patch.groupPrompt === 'string') cfg.groupPrompt = patch.groupPrompt;
  if (patch.kb && typeof patch.kb === 'object') cfg.kb = patch.kb;

  if (Array.isArray(patch.providers)) {
    cfg.providers = patch.providers.map((p) => {
      const old = (cfg.providers || []).find((x) => x.id === p.id);
      let apiKeyEnc = old ? old.apiKeyEnc : '';
      if (typeof p.apiKey === 'string' && p.apiKey) apiKeyEnc = encryptKey(p.apiKey);
      if (p.clearKey) apiKeyEnc = '';
      return normalizeProvider({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKeyEnc,
        models: p.models,
      });
    });
  }

  if (Array.isArray(patch.members)) {
    cfg.members = patch.members.map((m) => ({
      id: m.id || newId(),
      name: m.name || '成员',
      providerId: m.providerId || (cfg.providers[0] ? cfg.providers[0].id : null),
      model: m.model || '',
      persona: m.persona || '',
      temp: typeof m.temp === 'number' ? m.temp : 0.7,
      color: m.color || '#5b8def',
      maxTokens: Number(m.maxTokens) || 0,
      reasoning: m.reasoning || 'off',
      supportsImages: Boolean(m.supportsImages),
      enabled: m.enabled !== false,
    }));
  }

  if (patch.settings) cfg.settings = { ...cfg.settings, ...patch.settings };

  saveConfig(cfg);
  applyProxy(cfg);
  return { ok: true };
});

ipcMain.handle('models:list', async (_e, providerId, apiKey) => {
  const cfg = loadConfig();
  return listModels(cfg, providerId, apiKey || undefined);
});

/* ---------------- 联网搜索 ---------------- */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/* ---------- EPUB：ZIP 容器 + XHTML，无需第三方库 ---------- */

/** 极简 ZIP 读取：解析 central directory，返回 文件名 -> Buffer */
function zipReadAll(buf) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB（找不到 ZIP 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    try {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) entries.set(name, Buffer.from(data));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
    } catch { /* 单个文件损坏就跳过 */ }
  }
  return entries;
}

/** 保留段落换行的 XHTML 转文本 */
function epubStrip(html) {
  let t = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 解析 EPUB：按 spine 顺序抽出全部章节文本，顶部带目录 */
function epubExtract(filePath) {
  const buf = fs.readFileSync(filePath);
  const files = zipReadAll(buf);
  const get = (p) => {
    if (!p) return null;
    const key = String(p).replace(/^\//, '');
    return files.get(key) || files.get(decodeURIComponent(key)) || null;
  };

  // container.xml → OPF
  const container = get('META-INF/container.xml');
  const containerText = container ? decodeTextBuffer(container) : '';
  const m = containerText.match(/<rootfile[^>]+full-path="([^"]+)"/i);
  if (!m) throw new Error('EPUB 结构异常：找不到 OPF 描述文件');
  const opfPath = m[1];
  const opfDirRaw = path.posix.dirname(opfPath);
  const opfDir = opfDirRaw && opfDirRaw !== '.' ? opfDirRaw : '';
  const opfBuf = get(opfPath);
  const opf = opfBuf ? decodeTextBuffer(opfBuf) : '';
  if (!opf) throw new Error('EPUB 结构异常：OPF 文件为空');

  // manifest：id -> {href, media-type}
  const manifest = new Map();
  for (const mm of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = mm[0];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    const href = (tag.match(/\bhref="([^"]+)"/) || [])[1];
    const mt = (tag.match(/\bmedia-type="([^"]+)"/) || [])[1] || '';
    if (id && href) manifest.set(id, { href, mt });
  }

  // spine 顺序
  const order = [];
  for (const mm of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = (mm[0].match(/\bidref="([^"]+)"/) || [])[1];
    if (idref && manifest.has(idref)) order.push(manifest.get(idref));
  }

  const bookTitle = stripTags((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '');

  const parts = [];
  const seen = new Set();
  for (const item of order) {
    if (!item || !/xhtml|html/i.test(item.mt)) continue;
    const rel = opfDir ? opfDir + '/' + item.href : item.href;
    const doc = get(rel);
    if (!doc) continue;
    const html = decodeTextBuffer(doc);
    if (seen.has(html)) continue;
    seen.add(html);

    let chTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    if (!chTitle) chTitle = (html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || '';
    chTitle = epubStrip(chTitle).slice(0, 60);

    const text = epubStrip(html);
    if (text) parts.push({ title: chTitle, text });
  }

  // 兜底：spine 没解析出来，就按文件名自然序读所有 HTML
  if (!parts.length) {
    const list = [];
    for (const [name, data] of files) {
      if (!data || !/\.(xhtml|html|htm)$/i.test(name)) continue;
      const text = epubStrip(decodeTextBuffer(data));
      if (text) list.push({ title: name, text });
    }
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
    parts.push(...list.slice(0, 500));
  }
  if (!parts.length) throw new Error('EPUB 里没有可读的章节文本');

  const MAX_CHARS = 3000000;
  let body = '';
  let cut = 0;
  for (let i = 0; i < parts.length; i++) {
    const seg = `\n\n【第 ${i + 1} 节｜${parts[i].title || '无标题'}】\n${parts[i].text}`;
    if (body.length + seg.length > MAX_CHARS) { cut = parts.length - i; break; }
    body += seg;
  }

  const toc = parts.map((p, i) => `${i + 1}. ${p.title || '无标题'}`);
  const head =
    (bookTitle ? `【书名】${bookTitle}\n` : '') +
    `【格式】EPUB，共 ${parts.length} 节，提取 ${body.length} 字符\n` +
    `【目录】\n${toc.join('\n')}`;
  return head + '\n' + body + (cut ? `\n\n（达到单本提取上限，最后 ${cut} 节未包含）` : '');
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpFetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

async function searchBing(query) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&ensearch=0`;
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error('Bing HTTP ' + status);
  const out = [];
  const blocks = text.split(/<li class="b_algo"/i).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const href = decodeEntities(m[1]);
    const title = stripTags(m[2]);
    const snip = (b.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    if (!/^https?:\/\//i.test(href)) continue;
    out.push({ title, url: href, snippet: stripTags(snip).slice(0, 300) });
    if (out.length >= 8) break;
  }
  return out;
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, text } = await fetchText(url);
  if (status !== 200) throw new Error('DDG HTTP ' + status);
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 8) {
    let href = decodeEntities(m[1]);
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    out.push({ title: stripTags(m[2]), url: href, snippet: stripTags(m[3]).slice(0, 300) });
  }
  return out;
}

ipcMain.handle('websearch:run', async (_e, { query, fetchPages = 3, maxChars = 1500 }) => {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '空查询', results: [] };

  const sources = [];
  let results = [];
  const errors = [];

  for (const [name, fn] of [['bing', searchBing], ['duckduckgo', searchDuckDuckGo]]) {
    try {
      const r = await fn(q);
      if (r.length) { results = r; sources.push(name); break; }
      errors.push(`${name}: 无结果`);
    } catch (e) {
      errors.push(`${name}: ${String(e.message || e).slice(0, 80)}`);
    }
  }

  if (!results.length) {
    return { ok: false, error: errors.join(' | '), results: [], pages: [] };
  }

  // 抓正文（前 N 条）
  const pages = [];
  for (const r of results.slice(0, fetchPages)) {
    try {
      const { status, text } = await fetchText(r.url, 12000);
      if (status !== 200) continue;
      const body = stripTags(text);
      if (body.length < 80) continue;
      pages.push({ title: r.title, url: r.url, content: body.slice(0, maxChars) });
    } catch { /* 单条失败忽略 */ }
  }

  appendDiag({ kind: 'search', query: q, source: sources[0], results: results.length, pages: pages.length });
  return { ok: true, source: sources[0], results: results.slice(0, 8), pages, error: null };
});

/* ---------------- 模型榜单（Artificial Analysis 智能指数） ---------------- */

const RANKING_FILE = path.join(USER_DIR, 'ranking.json');
const RANKING_URL = 'https://artificialanalysis.ai/leaderboards/models';

/** 从 AA 页面的 RSC 负载里抽出 initialModels（含 intelligenceIndex） */
function parseAaRanking(html) {
  const text = String(html).replace(/\\"/g, '"');
  const at = text.indexOf('"initialModels":[');
  if (at < 0) return [];
  const start = text.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];

  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  return arr
    .filter((m) => m && typeof m.intelligenceIndex === 'number' && m.name)
    .map((m) => ({
      name: String(m.name),
      slug: String(m.slug || ''),
      creator: String(m.modelCreatorName || ''),
      score: Number(m.intelligenceIndex),
      context: Number(m.contextWindowTokens) || 0,
      priceOut: Number(m.price1mOutputTokens) || null,
      openWeights: m.isOpenWeights === true,
    }))
    .sort((a, b) => b.score - a.score)
    .map((m, i) => Object.assign(m, { rank: i + 1 }));
}

ipcMain.handle('ranking:fetch', async () => {
  try {
    const { status, text } = await fetchText(RANKING_URL, 60000);
    if (status !== 200) return { ok: false, error: 'HTTP ' + status };
    const models = parseAaRanking(text);
    if (!models.length) return { ok: false, error: '页面结构变化，未解析到榜单数据' };
    const payload = { updatedAt: Date.now(), source: RANKING_URL, models };
    try { fs.writeFileSync(RANKING_FILE, JSON.stringify(payload)); } catch { /* 缓存失败不影响返回 */ }
    appendDiag({ kind: 'ranking', models: models.length, top: models[0] && models[0].name });
    return Object.assign({ ok: true }, payload);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ranking:cache', () => {
  try {
    if (!fs.existsSync(RANKING_FILE)) return { ok: false, error: '没有缓存' };
    const data = JSON.parse(fs.readFileSync(RANKING_FILE, 'utf8'));
    if (!data || !Array.isArray(data.models)) return { ok: false, error: '缓存损坏' };
    return Object.assign({ ok: true }, data);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

/* ---------------- 知识库 ---------------- */

const TEXT_EXTS = new Set([
    '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yml', '.yaml', '.xml', '.ini', '.conf',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.go', '.rs', '.rb', '.php', '.sh', '.ps1', '.bat', '.sql', '.html', '.css', '.vue', '.swift', '.kt',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

function fileHash(p) {
  try {
    const st = fs.statSync(p);
    return crypto.createHash('sha1').update('v2:' + p + ':' + st.size + ':' + st.mtimeMs).digest('hex').slice(0, 16);
  } catch {
    return crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);
  }
}

function cachePath(p) {
  return path.join(KB_CACHE_DIR, fileHash(p) + '.txt');
}

/** 尽量把字节解成正确的中文：BOM → UTF-16 → UTF-8 → GB18030/GBK/Big5 */
function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    try { return new TextDecoder('utf-16le').decode(buf); } catch { /* 继续 */ }
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    try { return new TextDecoder('utf-16be').decode(buf); } catch { /* 继续 */ }
  }

  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (!bad) return utf8;

  // 有替换符说明不是 UTF-8：按中文常见编码依次试
  for (const enc of ['gb18030', 'gbk', 'big5']) {
    try {
      const alt = new TextDecoder(enc).decode(buf);
      const altBad = (alt.match(/\uFFFD/g) || []).length;
      if (altBad < bad) return alt;
    } catch { /* 该编码不可用 */ }
  }
  return utf8;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (TEXT_EXTS.has(ext)) {
    return decodeTextBuffer(fs.readFileSync(filePath));
  }

  if (ext === '.pdf') {
    // pdf-parse v2 导出的是 PDFParse 类
    const { PDFParse } = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      return (result.text || '').replace(/\n-- \d+ of \d+ --\n?$/, '\n');
    } finally {
      try { await parser.destroy(); } catch { /* 忽略 */ }
    }
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ path: filePath });
    return r.value || '';
  }

  if (ext === '.epub') {
    return epubExtract(filePath);
  }

  if (ext === '.doc') {
    throw new Error('不支持旧版 .doc，请另存为 .docx');
  }

  if (ext === '.mobi' || ext === '.azw3' || ext === '.azw') {
    throw new Error('暂不支持 ' + ext + '，请先用 Calibre 转成 .epub 或导出 .txt');
  }

  throw new Error('不支持的文件类型：' + (ext || '无扩展名'));
}

/** Windows 自带 OCR（WinRT），不需要安装额外软件 */
async function ocrImage(filePath) {
  const script = path.join(__dirname, 'tools', 'ocr.ps1');
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', filePath],
      { timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).slice(0, 300)));
        let text = String(stdout || '').trim();
        // Windows OCR 会在汉字之间插空格，去掉它
        text = text.replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '');
        resolve(text);
      });
  });
}


/* ---------- 知识库检索 ---------- */

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;
const chunkCache = new Map();   // path -> { mtime, chunks: string[] }

/** 按长度切块，尽量在换行处断开 */
function splitChunks(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK_SIZE);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + CHUNK_SIZE * 0.5) end = nl;
    }
    chunks.push(text.slice(i, end));
    if (end >= text.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}

/** 中文按二元组、英文按单词切分查询词 */
function queryTerms(query) {
  const q = String(query || '').toLowerCase();
  const terms = new Set();
  for (const m of q.matchAll(/[a-z0-9_]{2,}/g)) terms.add(m[0]);
  for (const seg of q.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/)) {
    if (seg.length === 1) terms.add(seg);
    for (let i = 0; i + 1 < seg.length; i++) terms.add(seg.slice(i, i + 2));
  }
  return [...terms].filter(Boolean).slice(0, 60);
}

function scoreChunk(chunk, terms) {
  if (!terms.length) return 0;
  const low = chunk.toLowerCase();
  let score = 0;
  for (const t of terms) {
    let idx = 0;
    let hits = 0;
    while ((idx = low.indexOf(t, idx)) >= 0 && hits < 12) {
      hits++;
      idx += t.length;
    }
    if (hits) score += hits * (t.length >= 2 ? 1 : 0.4);
  }
  return score;
}

async function docChunks(entry) {
  const cached = chunkCache.get(entry.path);
  try {
    const st = fs.statSync(entry.path);
    if (cached && cached.mtime === st.mtimeMs) return cached.chunks;
  } catch { /* 文件可能被删，用缓存 */ }

  let text = await kbEnsureCache(entry);
  text = String(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = splitChunks(text);
  chunkCache.set(entry.path, { mtime: Date.now(), chunks });
  return chunks;
}

/**
 * 从知识库里挑最相关的片段。
 * 有 query 就按关键词打分排序；没有 query 就按原顺序取前几块。
 */
async function pickKbChunks(docs, query, budget) {
  const terms = queryTerms(query);
  const scored = [];
  let skipped = 0;

  for (const f of docs) {
    let chunks;
    try {
      chunks = await docChunks(f);
    } catch {
      skipped++;
      continue;
    }
    if (!chunks.length) { skipped++; continue; }

    chunks.forEach((chunk, idx) => {
      scored.push({ file: f.name, idx, chunk, score: scoreChunk(chunk, terms) });
    });
  }

  if (!scored.length) return { parts: [], used: 0, skipped, matched: 0, total: 0 };

  const total = scored.length;
  let picked;

  if (terms.length) {
    const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    // 有命中就用命中的；一个都没命中时退回原文前几块
    picked = hits.length ? hits : scored.slice(0, 12);
  } else {
    picked = scored.slice(0, 12);
  }

  const parts = [];
  let used = 0;
  const seenFiles = new Set();

  for (const item of picked) {
    const block = `【${item.file}】\n${item.chunk.trim()}`;
    if (used + block.length > budget) {
      const remain = budget - used;
      if (remain < 200) break;
      parts.push(block.slice(0, remain));
      used += remain;
      break;
    }
    parts.push(block);
    used += block.length;
    seenFiles.add(item.file);
  }

  return {
    parts,
    used,
    skipped,
    matched: picked.filter((x) => x.score > 0).length,
    total,
    filesUsed: seenFiles.size,
  };
}

const PARSE_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 解析超时（>${Math.round(ms / 1000)}s）`)), ms)),
  ]);
}

async function kbEnsureCache(entry) {
  const cp = cachePath(entry.path);
  if (fs.existsSync(cp)) return fs.readFileSync(cp, 'utf8');

  let text = '';
  // 大文件给更多时间：60 秒 + 每兆 1 秒，上限 10 分钟
  let timeout = PARSE_TIMEOUT_MS;
  try {
    const st = fs.statSync(entry.path);
    timeout = Math.min(600000, PARSE_TIMEOUT_MS + Math.floor(st.size / (1024 * 1024)) * 1000);
  } catch { /* 按默认超时 */ }
  if (entry.kind === 'image') {
    text = await withTimeout(ocrImage(entry.path), timeout, '图片识别');
  } else {
    text = await withTimeout(extractText(entry.path), timeout, '文档');
  }
  fs.mkdirSync(KB_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cp, text, 'utf8');
  return text;
}


ipcMain.handle('kb:cacheInfo', () => {
  let bytes = 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(KB_CACHE_DIR)) {
      try {
        bytes += fs.statSync(path.join(KB_CACHE_DIR, f)).size;
        count++;
      } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  return { count, bytes, dir: KB_CACHE_DIR };
});

ipcMain.handle('kb:clearCache', () => {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(KB_CACHE_DIR)) {
      try {
        fs.unlinkSync(path.join(KB_CACHE_DIR, f));
        removed++;
      } catch { /* 忽略单文件 */ }
    }
  } catch { /* 目录不存在 */ }
  chunkCache.clear();
  return { removed };
});


/* ---------- 右键菜单 ---------- */
ipcMain.on('menu:context', (e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;

  const items = [];
  if (opts.editable) {
    items.push({ role: 'undo', label: '撤销' });
    items.push({ role: 'redo', label: '重做' });
    items.push({ type: 'separator' });
    items.push({ role: 'cut', label: '剪切' });
  }
  items.push({ role: 'copy', label: '复制' });
  if (opts.editable) items.push({ role: 'paste', label: '粘贴' });
  items.push({ type: 'separator' });
  items.push({ role: 'selectAll', label: '全选' });

  Menu.buildFromTemplate(items).popup({ window: win });
});

/* ---------- 应用信息 ---------- */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  dataDir: USER_DIR,
  repo: 'https://github.com/Thams94/think-tank',
  releases: 'https://github.com/Thams94/think-tank/releases/latest',
}));

ipcMain.handle('app:openPath', (_e, target) => {
  const allowed = [USER_DIR];
  const t = String(target || '');
  if (!allowed.some((a) => t === a || t.startsWith(a + path.sep))) return { ok: false, error: '不允许打开该路径' };
  shell.openPath(t);
  return { ok: true };
});

ipcMain.handle('app:openExternal', (_e, url) => {
  const u = String(url || '');
  if (!/^https:\/\/github\.com\/Thams94\//.test(u)) return { ok: false, error: '只允许打开项目相关链接' };
  shell.openExternal(u);
  return { ok: true };
});

ipcMain.handle('kb:pick', async () => {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const r = await dialog.showOpenDialog(win, {
    title: '添加知识库文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'epub'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: '代码/文本', extensions: ['json', 'csv', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'go', 'rs', 'sql', 'html', 'css', 'yml', 'yaml', 'xml', 'log'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  try {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.focus(); }
  } catch { /* 忽略 */ }
  if (r.canceled) return [];
  for (const f of r.filePaths) approvePath(f);
  return r.filePaths;
});



/* ---------- 知识库路径授权 ----------
 * 渲染进程只能索引"用户通过对话框/扫描得到的路径"，
 * 避免 IPC 被用来读取任意文件。授权记录持久化，重启后仍有效。
 */
const KB_APPROVED_FILE = path.join(USER_DIR, 'kb-approved.json');
let kbApprovedRoots = new Set();

function loadApproved() {
  try {
    const arr = JSON.parse(fs.readFileSync(KB_APPROVED_FILE, 'utf8'));
    if (Array.isArray(arr)) kbApprovedRoots = new Set(arr);
  } catch { /* 首次运行 */ }
  return kbApprovedRoots;
}

function saveApproved() {
  try {
    fs.writeFileSync(KB_APPROVED_FILE, JSON.stringify([...kbApprovedRoots], null, 2), 'utf8');
  } catch { /* 忽略 */ }
}

function realOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function approvePath(p) {
  if (!p) return;
  const abs = realOrResolve(p);
  kbApprovedRoots.add(abs);
  saveApproved();
}

function isApprovedPath(p) {
  if (!p) return false;
  const abs = realOrResolve(p);
  for (const root of kbApprovedRoots) {
    if (abs === root) return true;
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

loadApproved();

/** 递归扫描目录，返回可读文档路径（带数量/深度限制，跳过依赖与隐藏目录） */
function scanFolder(root) {
  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'release', 'target',
    '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vscode', 'coverage',
    // 第三方库与运行时数据：不属于项目自有代码，一并跳过
    'vendor', 'third_party', 'vendor.js', 'assets', 'kb-cache', 'sessions',
    'backup', 'test', 'tests', '__tests__', 'tools',
  ]);
  const LIMIT = { files: 800, depth: 8, sizeBytes: 100 * 1024 * 1024 };

  const out = [];
  const images = [];
  let truncated = false;

  const realRoot = realOrResolve(root);

  function walk(dir, depth) {
    if (out.length >= LIMIT.files) { truncated = true; return; }
    if (depth > LIMIT.depth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= LIMIT.files) { truncated = true; return; }
      const name = ent.name;
      if (name.startsWith('.')) continue;

      const full = path.join(dir, name);

      // 不跟随符号链接 / Windows junction，避免越出所选目录
      if (ent.isSymbolicLink()) continue;

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        // 双重保险：递归前验证真实路径仍在根目录内
        const real = realOrResolve(full);
        const rel = path.relative(realRoot, real);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;

      const ext = path.extname(name).toLowerCase();
      const isDoc = TEXT_EXTS.has(ext) || ext === '.pdf' || ext === '.docx' || ext === '.epub';
      const isImage = IMAGE_EXTS.has(ext);
      if (!isDoc && !isImage) continue;
      // 图片单独限流：一次最多 40 张，避免误选图片素材目录
      if (isImage && images.length >= 40) continue;
      if (isImage) { images.push(full); continue; }

      try {
        const st = fs.statSync(full);
        if (st.size > LIMIT.sizeBytes) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }

  walk(root, 0);
  // 用户明确选择了这个目录，扫描结果视为已授权
  approvePath(root);
  for (const f of out) approvePath(path.dirname(f));
  for (const f of images) approvePath(path.dirname(f));
  return { paths: out.concat(images), truncated, imageCount: images.length };
}

ipcMain.handle('kb:scanFolder', (_e, dir) => {
  const target = String(dir || '').trim();
  if (!target) return { paths: [], truncated: false, error: '空路径' };
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return { paths: [], truncated: false, error: '不是文件夹' };
  } catch (err) {
    return { paths: [], truncated: false, error: '路径不存在：' + target };
  }
  return scanFolder(target);
});

ipcMain.handle('kb:pickFolder', async () => {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const r = await dialog.showOpenDialog(win, {
    title: '选择知识库文件夹（会递归扫描其中的文档）',
    properties: ['openDirectory'],
  });
  try {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.focus(); }
  } catch { /* 忽略 */ }
  if (r.canceled || !r.filePaths.length) return { paths: [], truncated: false };
  return scanFolder(r.filePaths[0]);
});

ipcMain.handle('kb:index', async (_e, paths) => {
  const out = [];
  for (const p of paths || []) {
    if (!isApprovedPath(p)) {
      out.push({ path: p, name: path.basename(p), kind: 'doc', ok: false, chars: 0, error: '未授权的路径，请重新选择文件' });
      continue;
    }
    const ext = path.extname(p).toLowerCase();
    const kind = IMAGE_EXTS.has(ext) ? 'image' : 'doc';
    const entry = { path: p, name: path.basename(p), kind };

    // 图片不在导入时解析：视觉模型直接看图；需要 OCR 时在组装上下文阶段按需转写
    if (kind === 'image') {
      try {
        const st = fs.statSync(p);
        entry.bytes = st.size;
        entry.ok = true;
        entry.chars = 0;
      } catch (e) {
        entry.ok = false;
        entry.error = String(e.message || e);
      }
      out.push(entry);
      continue;
    }

    try {
      const text = await kbEnsureCache(entry);
      entry.chars = text.length;
      entry.ok = true;
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message || e);
      entry.chars = 0;
    }
    out.push(entry);
  }
  return out;
});

/**
 * 组装知识库上下文。
 * budget: 允许注入的最大字符数（约等于 tokens * 1.5 的中文比例，粗算即可）
 * wantImages: 成员是否支持看图（支持则返回图片，交给模型直接看）
 */
/** 结构大纲：抽函数/类/路由/标题等骨架，让模型即使看不到全文也知道里面有什么 */
function fileOutline(name, text) {
  const ext = path.extname(name).toLowerCase();
  const lines = String(text).split('\n');
  const hits = [];
  const MAX = 80;
  const add = (i, l) => { if (hits.length < MAX) hits.push(`${i + 1}: ${l.trim().slice(0, 110)}`); };

  const norm = ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? '.js'
    : ext === '.tsx' ? '.ts'
    : ext === '.htm' ? '.html' : ext;

  const rules = {
    '.py': [/^\s*(async\s+def|def|class)\s+\w+/],
    '.js': [
      /^\s*(export\s+(default\s+)?)?(async\s+)?(function|class)\s+\w+/,
      /^\s*(app|router|server)\.(get|post|put|delete|use|all)\(/,
      /^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/,
    ],
    '.ts': [
      /^\s*(export\s+)?(async\s+)?(function|class|interface|type)\s+\w+/,
      /^\s*(app|router)\.(get|post|put|delete|use)\(/,
    ],
    '.html': [/<section\b/, /<script\b/, /<\/script>/, /<form\b/, /<main\b/, /id="[A-Za-z][\w-]*"/],
    '.css': [/^\s*[.#][\w-]+[^{]*\{/],
    '.md': [/^#{1,4}\s+\S/],
    '.json': [/^ {0,4}"[^"]+"\s*:/],
    '.yml': [/^[\w-]+\s*:/],
    '.yaml': [/^[\w-]+\s*:/],
  };

  const list = rules[norm] || [];
  if (list.length) {
    lines.forEach((l, i) => { if (list.some((re) => re.test(l))) add(i, l); });
    return hits;
  }

  // 通用：像标题/条款的短行
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && t.length <= 60 && /^(第[一二三四五六七八九十百]+[章节条]|[一二三四五六七八九十]+、|\(?\d+[.、)]|[A-Z][A-Za-z ]{2,30}:?$)/.test(t)) add(i, t);
  });
  return hits;
}

/** 在文件中部均匀取若干窗口，弥补"只读头尾"的盲区 */
function sampleWindows(totalLines, headLines, tailLines, budgetChars) {
  const win = 40;
  const start = headLines;
  const end = totalLines - tailLines;
  const span = end - start;
  if (span <= win * 2) return [];
  const count = Math.max(2, Math.min(8, Math.floor(budgetChars / (win * 45))));
  const out = [];
  for (let k = 1; k <= count; k++) {
    const center = start + Math.floor(span * (k / (count + 1)));
    const from = Math.max(start, center - Math.floor(win / 2));
    const to = Math.min(end, from + win);
    if (to - from >= 10) out.push([from, to]);
  }
  return out;
}

/** 单文件渲染：完整 / 大纲 + 头 + 中段采样 + 尾（并标注缺了哪些行） */
function renderKbFile(entry, text, allowance) {
  const lines = String(text).split('\n');
  const totalLines = lines.length;
  const totalChars = text.length;
  const header = `【${entry.name}】${totalLines} 行 / ${totalChars} 字`;

  if (totalChars <= allowance) {
    return { block: `${header}\n${text}`, full: true, injected: totalLines, totalLines };
  }

  const outline = fileOutline(entry.name, text);
  const headBudget = Math.max(600, Math.floor(allowance * 0.55));
  const tailBudget = Math.max(0, Math.floor(allowance * 0.18));

  const headLines = [];
  let hLen = 0;
  for (let i = 0; i < totalLines && hLen < headBudget; i++) {
    headLines.push(lines[i]);
    hLen += lines[i].length + 1;
  }

  const tailLines = [];
  let tLen = 0;
  for (let j = totalLines - 1; j >= headLines.length && tLen < tailBudget; j--) {
    tailLines.unshift(lines[j]);
    tLen += lines[j].length + 1;
  }

  const parts = [header];
  if (outline.length) parts.push('[结构大纲]\n' + outline.map((x) => '  ' + x).join('\n'));
  parts.push(`[第 1–${headLines.length} 行]\n${headLines.join('\n').trimEnd()}`);

  // 中段均匀采样：让模型能看到文件中间的实际内容，而不是只能凭大纲猜
  const sampleBudget = Math.min(Math.floor(allowance * 0.3), 12000);
  const windows = sampleWindows(totalLines, headLines.length, tailLines.length, sampleBudget);
  let sampledLines = 0;
  for (const [from, to] of windows) {
    const slice = lines.slice(from, to);
    parts.push(`[采样 第 ${from + 1}–${to} 行]\n${slice.join('\n').trimEnd()}`);
    sampledLines += slice.length;
  }

  if (tailLines.length) {
    const from = totalLines - tailLines.length + 1;
    parts.push(`[第 ${from}–${totalLines} 行]\n${tailLines.join('\n')}`);
  }
  const startTail = totalLines - tailLines.length + 1;
  const injected = headLines.length + tailLines.length + sampledLines;
  const missing = Math.max(totalLines - injected, 0);
  parts.push(
    `⚠ 共 ${totalLines} 行；此处注入了第 1–${headLines.length} 行、结构大纲、` +
    `${windows.length} 段中段采样` +
    (tailLines.length ? `和第 ${startTail}–${totalLines} 行` : '') +
    `，合计约 ${injected} 行，其余 ${missing} 行未注入。**未注入不等于不存在**；` +
    `引用结论时必须区分"看到了"和"没看到"，没看到的只能标待核实，不能当成不存在。`
  );
  return { block: parts.join('\n'), full: false, injected, totalLines };
}

/** 审核友好的上下文：保证每个文件都有内容，并返回材料清单 */
async function buildKbBlocks(docs, budget, focus) {
  const items = [];
  let skipped = 0;

  for (const f of docs) {
    try {
      const text = String(await kbEnsureCache(f)).replace(/\r\n/g, '\n');
      if (!text.trim()) { skipped++; continue; }
      items.push({ entry: f, text });
    } catch {
      skipped++;
    }
  }

  const inventory = items.map((it) => ({
    name: it.entry.name,
    lines: it.text.split('\n').length,
    chars: it.text.length,
  }));

  const alloc = new Map();

  // ---- 按议题挑相关文件：命中议题关键词的文件给足预算，其余只给大纲+头部 ----
  const terms = queryTerms(focus || '');
  let primary = items;
  let secondary = [];

  if (terms.length && items.length > 1) {
    // 用 IDF 压低"每个文件都有"的通用词，突出真正能区分文件的关键词
    const lowers = items.map((it) => it.text.toLowerCase());
    const tt2 = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
    const df = new Map();
    for (const t of tt2) {
      let n = 0;
      for (const txt of lowers) if (txt.includes(t)) n++;
      df.set(t, n);
    }
    const N = items.length;

    const scored = items.map((it) => {
      const lower = it.text.toLowerCase();
      let hits = 0;
      for (const tt of tt2) {
        const d = df.get(tt) || 0;
        if (d === 0 || d === N) continue;          // 谁都有 / 谁都没有的词不计分
        const w = Math.log(N / d) + 1;
        let idx = 0;
        let c = 0;
        while (c < 40) {
          const pos = lower.indexOf(tt, idx);
          if (pos < 0) break;
          c++;
          idx = pos + tt.length;
        }
        hits += c * w;
      }
      // 按长度对数归一化：避免超大文件凭命中数压倒一切
      const density = hits / Math.log2(it.text.length + 2);
      return { it, hits, density };
    });
    const hot = scored.filter((x) => x.hits > 0 && x.density > 0).sort((a, b) => b.density - a.density).slice(0, 2);
    if (hot.length) {
      const hotPaths = new Set(hot.map((x) => x.it.entry.path));
      primary = items.filter((it) => hotPaths.has(it.entry.path));
      secondary = items.filter((it) => !hotPaths.has(it.entry.path));
    }
  }

  const primaryBudget = secondary.length ? Math.floor(budget * 0.78) : budget;
  const secondaryBudget = budget - primaryBudget;
  let pool = primaryBudget;

  // 1) 相关文件：小的整份注入
  const sorted = primary.slice().sort((a, b) => a.text.length - b.text.length);
  const pending = [];
  for (const it of sorted) {
    const cap = Math.max(8000, Math.floor(pool * 0.45));
    if (it.text.length <= cap && it.text.length <= pool) {
      alloc.set(it.entry.path, it.text.length);
      pool -= it.text.length;
    } else {
      pending.push(it);
    }
  }

  // 2) 其余相关文件按 sqrt(大小) 分剩余预算，保证每份至少有内容
  if (pending.length) {
    const weights = pending.map((it) => Math.sqrt(it.text.length));
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    const left = Math.max(pool, 0);
    const minEach = Math.min(1500, Math.floor(Math.max(left, 1) * 0.3 / pending.length) || 800);
    pending.forEach((it, i) => {
      let share = Math.floor(left * (weights[i] / wsum));
      if (share < minEach) share = Math.min(minEach, it.text.length);
      const hard = Math.max(800, it.text.length);
      alloc.set(it.entry.path, Math.min(Math.min(share, hard), it.text.length));
    });
  }

  // 3) 次要文件：只给大纲 + 头部，够判断"里面有没有相关东西"即可
  if (secondary.length) {
    const each = Math.max(600, Math.floor(secondaryBudget / secondary.length));
    for (const it of secondary) {
      alloc.set(it.entry.path, Math.min(each, it.text.length));
    }
  }

  const blocks = [];
  const truncated = [];
  let used = 0;
  for (const it of items) {
    const allowance = alloc.get(it.entry.path) || 800;
    const r = renderKbFile(it.entry, it.text, allowance);
    blocks.push(r.block);
    used += r.block.length;
    if (!r.full) truncated.push({ name: it.entry.name, injected: r.injected, total: r.totalLines });
  }

  return {
    text: blocks.join('\n\n'),
    used,
    skipped,
    inventory,
    truncated,
    focused: primary.map((it) => it.entry.name),
    totalChars: items.reduce((a, b) => a + b.text.length, 0),
  };
}

ipcMain.handle('kb:context', async (_e, { files, budget = 12000, wantImages = false, query = '', focus = '' }) => {
  const safeFiles = (files || []).filter((f) => isApprovedPath(f.path));
  const docs = safeFiles.filter((f) => f.kind !== 'image');
  const images = safeFiles.filter((f) => f.kind === 'image');

  const parts = [];
  let used = 0;
  let skipped = 0;

  // 材料清单 + 按文件保证注入（审核场景必须看到每个文件，而不是被大文件吃光预算）
  const picked = await buildKbBlocks(docs, budget, focus || query);
  parts.push(picked.text);
  used += picked.used;
  skipped += picked.skipped;

  const text = parts.join('\n\n');

  // 图片：给视觉模型直接看（最多 6 张，避免请求过大）
  const imagePayload = [];
  if (wantImages) {
    for (const f of images.slice(0, 10)) {
      try {
        const buf = fs.readFileSync(f.path);
        const mime = f.path.toLowerCase().endsWith('.png') ? 'image/png'
          : f.path.toLowerCase().endsWith('.webp') ? 'image/webp'
          : f.path.toLowerCase().endsWith('.gif') ? 'image/gif'
          : f.path.toLowerCase().endsWith('.bmp') ? 'image/bmp'
          : 'image/jpeg';
        imagePayload.push({ name: f.name, url: `data:${mime};base64,${buf.toString('base64')}` });
      } catch { /* 忽略单张 */ }
    }
  } else {
    // 非视觉模型：把图片 OCR 成文字
    for (const f of images) {
      try {
        const t = (await kbEnsureCache(f)) || '';
        const clean = t.trim();
        if (!clean) continue;
        const remain = budget - used;
        if (remain <= 100) break;
        const slice = clean.slice(0, remain);
        parts.push(`【图片OCR：${f.name}】\n${slice}`);
        used += slice.length;
      } catch { /* 忽略 */ }
    }
  }

  return {
    text: parts.join('\n\n'),
    used,
    inventory: picked.inventory || [],
    truncated: picked.truncated || [],
    focused: picked.focused || [],
    totalChars: picked.totalChars || 0,
    filesUsed: (picked.inventory || []).length,
    skipped,
    docCount: docs.length,
    imageCount: images.length,
    images: imagePayload,
  };
});

/**
 * 知识库摘要：供策划模型"读文件"用。
 * 每个文档取头部 + （长文档）尾部，总预算受控，避免上下文爆炸。
 */
ipcMain.handle('kb:digest', async (_e, { files, budget = 40000 }) => {
  const docs = (files || []).filter((f) => f.kind !== 'image' && isApprovedPath(f.path));
  const images = (files || []).filter((f) => f.kind === 'image');
  const out = [];
  let used = 0;
  const perFile = Math.max(1000, Math.min(4000, Math.floor(budget / Math.max(docs.length, 1))));

  for (const f of docs) {
    if (used >= budget) break;
    try {
      const text = String(await kbEnsureCache(f))
        .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) {
        out.push({ name: f.name, chars: 0, head: '', tail: '' });
        continue;
      }
      const remain = budget - used;
      let head = text.slice(0, Math.min(perFile, remain));
      let tail = '';
      const headUsed = head.length;
      if (text.length > head.length + 400 && remain - headUsed > 400) {
        tail = text.slice(-Math.min(1200, remain - headUsed));
        if (tail.length < 100) tail = '';
      }
      used += head.length + tail.length;
      out.push({ name: f.name, chars: text.length, head, tail });
    } catch (e) {
      out.push({ name: f.name, chars: 0, head: '', tail: '', error: String(e.message || e) });
    }
  }
  return {
    files: out,
    images: images.map((f) => ({ name: f.name })),
    used,
    docCount: docs.length,
  };
});

/* ---------------- 会话存储 ---------------- */

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function saveSessionIndex(idx) {
  writeJson(SESSIONS_FILE, idx);
}

/** 读取索引；首次使用时把旧的 chats.json 迁移成第一个会话。 */
function loadSessionIndex() {
  let idx = readJson(SESSIONS_FILE, null);
  if (!idx || !Array.isArray(idx.sessions)) {
    idx = { sessions: [], activeId: null };
  }

  if (!idx.sessions.length) {
    const old = readJson(CHAT_FILE, { messages: [] });
    if (Array.isArray(old.messages) && old.messages.length) {
      const id = newId();
      const title = '历史会话';
      writeJson(sessionPath(id), { id, title, messages: old.messages });
      idx.sessions.push({
        id, title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: old.messages.length,
      });
      idx.activeId = id;
      saveSessionIndex(idx);
    }
  }

  return idx;
}

function touchSession(idx, id, patchObj) {
  const s = idx.sessions.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patchObj, { updatedAt: Date.now() });
  saveSessionIndex(idx);
  return s;
}

ipcMain.handle('sessions:list', () => {
  const idx = loadSessionIndex();
  return { sessions: idx.sessions, activeId: idx.activeId };
});

ipcMain.handle('sessions:create', (_e, title, members, kb, groupPrompt, issues) => {
  const idx = loadSessionIndex();
  const id = newId();
  const t = (title || '').trim() || '新会话';
  const snapshot = Array.isArray(members) ? JSON.parse(JSON.stringify(members)) : [];
  const kbSnapshot = kb && typeof kb === 'object'
    ? JSON.parse(JSON.stringify(kb))
    : { enabled: true, budget: 12000, files: [] };
  writeJson(sessionPath(id), {
    id, title: t, messages: [], members: snapshot, kb: kbSnapshot,
    groupPrompt: typeof groupPrompt === 'string' ? groupPrompt : '',
    issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : [],
  });
  idx.sessions.unshift({ id, title: t, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
  idx.activeId = id;
  saveSessionIndex(idx);
  return { id, title: t, messages: [], members: snapshot, kb: kbSnapshot, groupPrompt: typeof groupPrompt === 'string' ? groupPrompt : '', issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : [] };
});

ipcMain.handle('sessions:load', (_e, id) => {
  const idx = loadSessionIndex();
  const file = readJson(sessionPath(id), null);
  if (!file) return { id, title: '（已丢失）', messages: [] };
  idx.activeId = id;
  saveSessionIndex(idx);
  return file;
});

const sessionSaveSeq = new Map();   // 每个会话最后写入的保存序号，用来丢弃过期保存

ipcMain.handle('sessions:save', (_e, { id, messages, title, members, kb, groupPrompt, issues, seq }) => {
  // 序号更旧的保存直接丢弃：避免排队中的旧快照覆盖刚写入的新数据
  if (typeof seq === 'number') {
    const last = sessionSaveSeq.get(id) || 0;
    if (seq < last) return { ok: true, skipped: true, reason: 'stale-save' };
    sessionSaveSeq.set(id, seq);
  }
  const idx = loadSessionIndex();
  const existing = readJson(sessionPath(id), { id, title: '新会话', messages: [] });
  const data = {
    id,
    title: title || existing.title || '新会话',
    messages: Array.isArray(messages) ? messages : existing.messages,
    members: Array.isArray(members) ? JSON.parse(JSON.stringify(members)) : (existing.members || []),
    kb: (kb && typeof kb === 'object')
      ? JSON.parse(JSON.stringify(kb))
      : (existing.kb || { enabled: true, budget: 12000, files: [] }),
    groupPrompt: typeof groupPrompt === 'string' ? groupPrompt : (existing.groupPrompt || ''),
    issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : (existing.issues || []),
    savedAt: Date.now(),
  };
  writeJson(sessionPath(id), data);
  touchSession(idx, id, { messageCount: data.messages.length, title: data.title });
  return { ok: true, count: data.messages.length };
});

ipcMain.handle('sessions:rename', (_e, { id, title }) => {
  const idx = loadSessionIndex();
  const t = (title || '').trim() || '未命名';
  const file = readJson(sessionPath(id), { id, title: t, messages: [] });
  file.title = t;
  writeJson(sessionPath(id), file);
  touchSession(idx, id, { title: t });
  return { ok: true };
});

ipcMain.handle('sessions:delete', (_e, id) => {
  const idx = loadSessionIndex();
  idx.sessions = idx.sessions.filter((s) => s.id !== id);
  if (idx.activeId === id) idx.activeId = idx.sessions[0] ? idx.sessions[0].id : null;
  saveSessionIndex(idx);
  try { fs.unlinkSync(sessionPath(id)); } catch { /* 已不存在 */ }
  return { ok: true, activeId: idx.activeId };
});

ipcMain.handle('chat:load', () => readJson(CHAT_FILE, { messages: [] }));
ipcMain.handle('chat:save', (_e, data) => {
  writeJson(CHAT_FILE, data);
  return { ok: true };
});
ipcMain.handle('chat:clear', () => {
  writeJson(CHAT_FILE, { messages: [] });
  return { ok: true };
});

ipcMain.handle('chat:run', async (e, req) => {
  const { runId } = req;
  const cfg = loadConfig();
  const provider = getProvider(cfg, req.providerId);
  if (!provider) {
    return { ok: false, error: '没有可用的供应商，请先在设置里添加' };
  }
  const apiKey = decryptKey(provider.apiKeyEnc);

  const controller = new AbortController();
  running.set(runId, controller);
  const sender = e.sender;
  try {
    let msgs = req.messages;
    // 知识库图片：塞进最后一条 user 消息，变成多模态内容
    if (Array.isArray(req.images) && req.images.length) {
      msgs = msgs.slice();
      const lastIdx = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop();
      if (lastIdx !== undefined && lastIdx >= 0) {
        const last = msgs[lastIdx];
        msgs[lastIdx] = {
          role: 'user',
          content: [
            { type: 'text', text: String(last.content) },
            ...req.images.map((img) => ({ type: 'image_url', image_url: { url: img.url } })),
          ],
        };
      }
    }

    appendDiag({ kind: 'chat_start', model: req.model, providerId: req.providerId, runId: req.runId });

  const out = await streamChat({
      baseUrl: provider.baseUrl,
      apiKey,
      model: req.model,
      messages: msgs,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      reasoning: req.reasoning,
      signal: controller.signal,
      onDelta: (d) => {
        if (!sender.isDestroyed()) sender.send('chat:delta', { runId, ...d });
      },
    });
    if (!sender.isDestroyed()) {
      sender.send('chat:done', {
        runId, text: out.text, usage: out.usage,
        finishReason: out.finishReason, truncated: out.truncated, interrupted: out.interrupted,
      });
    }
    appendDiag({
      kind: 'chat', model: req.model, chars: out.text.length,
      finishReason: out.finishReason, sawDone: out.sawDone,
      truncated: out.truncated, interrupted: out.interrupted,
      reasoningChars: out.reasoningChars,
    });
    return {
      ok: true, text: out.text, usage: out.usage,
      finishReason: out.finishReason, truncated: out.truncated, interrupted: out.interrupted,
    };
  } catch (err) {
    const msg = String(err.message || err);
    if (!sender.isDestroyed()) sender.send('chat:error', { runId, message: msg });
    return { ok: false, error: msg };
  } finally {
    running.delete(runId);
  }
});

ipcMain.handle('plan:generate', async (_e, req) => {
  const cfg = loadConfig();
  const provider = getProvider(cfg, req.providerId);
  if (!provider) return { ok: false, error: '没有可用的供应商，请先在设置里添加' };
  const apiKey = decryptKey(provider.apiKeyEnc);
  try {
    const out = await completeChat({
      baseUrl: provider.baseUrl,
      apiKey,
      model: req.model,
      messages: req.messages,
      temperature: 0.3,
      maxTokens: req.maxTokens,
      reasoning: 'off',
      json: req.json !== false,
    });
    return { ok: true, text: out.text, usage: out.usage };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

function appendDiag(obj) {
  try {
    const line = new Date().toISOString() + ' ' + JSON.stringify(obj) + '\n';
    fs.appendFileSync(path.join(USER_DIR, 'diagnostics.log'), line, 'utf8');
  } catch { /* 忽略 */ }
}

/**
 * 强制把窗口拉到前台。
 * 原生对话框（confirm / 另存为）关闭后，Chromium 有时不会重新激活窗口，
 * 表现为：页面里 activeElement 是输入框，但 document.hasFocus() 为 false，
 * Windows 因此不显示光标、键盘事件也进不来。
 */
ipcMain.handle('win:refocus', () => {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' };
  const before = win.isFocused();
  const docFocused = true; // 仅作记录
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    // app.focus({steal:true}) 在 Windows 上可强制夺取前台
    try { app.focus({ steal: true }); } catch { /* 老版本不支持 */ }
    win.focus();
    win.webContents.focus();
    // 关键：让 Chromium 重新把页面焦点还给 WebContents（原生对话框后常丢这个）
    try { win.blur(); win.focus(); win.webContents.focus(); } catch { /* 忽略 */ }
    if (!win.isFocused()) {
      // Windows 前台锁会拦下 focus，用一次最小化/还原强制激活
      win.minimize();
      win.restore();
      win.focus();
      win.webContents.focus();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const after = win.isFocused();
  appendDiag({ kind: 'refocus', before, after });
  return { ok: after, before, after };
});

ipcMain.handle('diag:note', (_e, obj) => {
  try { appendDiag(obj); } catch { /* 忽略 */ }
  return { ok: true };
});

ipcMain.handle('diag:dump', (_e, info) => {
  const file = path.join(USER_DIR, 'diagnostics.log');
  try {
    fs.appendFileSync(file, new Date().toISOString() + ' FOCUS ' + JSON.stringify(info) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: file };
});

ipcMain.handle('export:markdown', async (_e, { content, defaultName }) => {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出讨论记录',
    defaultPath: defaultName || 'think-tank.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  // 原生存取对话框关闭后，窗口可能处于"未激活"状态，主动拉回前台
  try {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      win.webContents.focus();
    }
  } catch { /* 忽略 */ }

  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('chat:abort', (_e, runId) => {
  const c = running.get(runId);
  if (c) c.abort();
  return { ok: true };
});

/* ---------------- 启动 ---------------- */

app.whenReady().then(() => {
  applyProxy(loadConfig());
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
