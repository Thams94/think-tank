/**
 * 网页版桥接层：把桌面版用到的 window.api 全部用浏览器能力实现。
 *
 * 存储：IndexedDB（配置 / 会话 / 知识库缓存）
 * 请求：fetch + ReadableStream（SSE 流式）
 * 文件：<input type=file> + pdf.js / mammoth
 * 搜索：r.jina.ai（免 Key，有速率限制）
 */
(function () {
  'use strict';

  /* ================= IndexedDB ================= */

  const DB_NAME = 'think-tank-web';
  const DB_VER = 1;
  const LEGACY_DB = 'aigc-web';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kbcache')) db.createObjectStore('kbcache');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  let legacyReady = null;

  /** 把旧库 aigc-web 的数据搬到新库（仅当新库没有配置时执行一次） */
  function migrateLegacyDb() {
    if (legacyReady) return legacyReady;
    legacyReady = (async () => {
      try {
        if (!indexedDB.databases) return;
        const names = (await indexedDB.databases()).map((d) => d && d.name);
        if (!names.includes(LEGACY_DB)) return;

        const db = await openDb();
        const hasConfig = await new Promise((res) => {
          const t = db.transaction('kv', 'readonly');
          const g = t.objectStore('kv').get('config');
          g.onsuccess = () => res(!!g.result);
          g.onerror = () => res(true);
        });
        if (hasConfig) return;

        const oldDb = await new Promise((res) => {
          const r = indexedDB.open(LEGACY_DB);
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(null);
        });
        if (!oldDb) return;

        for (const store of ['kv', 'sessions', 'kbcache']) {
          if (!oldDb.objectStoreNames.contains(store)) continue;
          const dump = await new Promise((res) => {
            try {
              const t = oldDb.transaction(store, 'readonly');
              const os = t.objectStore(store);
              const keys = os.getAllKeys();
              const vals = os.getAll();
              t.oncomplete = () => res({ keys: keys.result, vals: vals.result });
              t.onerror = () => res(null);
            } catch { res(null); }
          });
          if (!dump || !dump.keys.length) continue;
          await new Promise((res) => {
            const t = db.transaction(store, 'readwrite');
            const os = t.objectStore(store);
            for (let i = 0; i < dump.keys.length; i++) {
              if (store === 'sessions') os.put(dump.vals[i]);
              else os.put(dump.vals[i], dump.keys[i]);
            }
            t.oncomplete = res;
            t.onerror = res;
            t.onabort = res;
          });
        }
        oldDb.close();
        console.log('[web-bridge] 已从旧库 aigc-web 迁移数据');
      } catch (e) {
        console.warn('[web-bridge] 旧库迁移失败（忽略）', e);
      }
    })();
    return legacyReady;
  }

  function tx(store, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      try {
        result = fn(os);
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  function idbGet(store, key) {
    return tx(store, 'readonly', (os) => ({ __req: os.get(key) }));
  }
  function idbPut(store, keyOrValue, maybeValue) {
    return tx(store, 'readwrite', (os) => {
      if (maybeValue === undefined) os.put(keyOrValue);
      else os.put(maybeValue, keyOrValue);
      return true;
    });
  }
  function idbDel(store, key) {
    return tx(store, 'readwrite', (os) => { os.delete(key); return true; });
  }
  function idbAll(store) {
    return tx(store, 'readonly', (os) => ({ __req: os.getAll() }));
  }

  /* ================= 工具 ================= */

  const uid = () => Math.random().toString(36).slice(2, 10);

  function encodeKey(k) {
    if (!k) return '';
    return 'plain:' + btoa(unescape(encodeURIComponent(k)));
  }
  function decodeKey(enc) {
    if (!enc) return '';
    if (enc.startsWith('plain:')) {
      try { return decodeURIComponent(escape(atob(enc.slice(6)))); } catch { return ''; }
    }
    try { return atob(enc); } catch { return ''; }
  }

  function normalizeBase(baseUrl) {
    let b = String(baseUrl || '').trim();
    if (!b) throw new Error('供应商还没填 API 地址');
    b = b.replace(/\/+$/, '');
    if (!/\/v\d+$/.test(b)) b += '/v1';
    return b;
  }

  const CORS_HINT = '请求被浏览器拦截。常见原因：该中转站不允许网页跨域访问（CORS）。\n\n解决办法：\n1. 换一个允许跨域的中转站\n2. 或用支持 CORS 的地址\n\n（这不是你的 Key 的问题）';

  function humanError(e) {
    const msg = String((e && e.message) || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return CORS_HINT;
    if (/abort/i.test(msg)) return 'aborted';
    return msg;
  }

  /* ================= 配置 ================= */

  const DEFAULT_CONFIG = {
    providers: [],
    proxy: '',
    groupPrompt: '',
    kb: { enabled: true, budget: 12000, files: [] },
    members: [],
    settings: {
      mode: 'manual', rounds: 1, moderatorId: null,
      searchEnabled: false, collapsed: { sessions: false, members: false },
    },
  };

  async function loadConfig() {
    await migrateLegacyDb();
    const cfg = (await idbGet('kv', 'config')) || {};
    return {
      providers: Array.isArray(cfg.providers) ? cfg.providers : [],
      proxy: cfg.proxy || '',
      groupPrompt: cfg.groupPrompt || '',
      kb: cfg.kb || { enabled: true, budget: 12000, files: [] },
      members: Array.isArray(cfg.members) ? cfg.members : [],
      settings: Object.assign({}, DEFAULT_CONFIG.settings, cfg.settings || {}),
    };
  }

  async function saveConfig(patch) {
    const cfg = await loadConfig();

    if (typeof patch.proxy === 'string') cfg.proxy = patch.proxy.trim();
    if (typeof patch.groupPrompt === 'string') cfg.groupPrompt = patch.groupPrompt;
    if (patch.kb && typeof patch.kb === 'object') cfg.kb = patch.kb;

    if (Array.isArray(patch.providers)) {
      cfg.providers = patch.providers.map((p) => {
        const old = cfg.providers.find((x) => x.id === p.id) || {};
        let apiKeyEnc = old.apiKeyEnc || '';
        if (typeof p.apiKey === 'string' && p.apiKey) apiKeyEnc = encodeKey(p.apiKey);
        if (p.clearKey) apiKeyEnc = '';
        return {
          id: p.id || uid(),
          name: p.name || '未命名供应商',
          baseUrl: p.baseUrl || '',
          apiKeyEnc,
          models: Array.isArray(p.models) ? p.models : (old.models || []),
        };
      });
    }

    if (Array.isArray(patch.members)) {
      cfg.members = patch.members.map((m) => ({
        id: m.id || uid(),
        name: m.name || '成员',
        providerId: m.providerId || (cfg.providers[0] ? cfg.providers[0].id : null),
        model: m.model || '',
        persona: m.persona || '',
        temp: typeof m.temp === 'number' ? m.temp : 0.7,
        color: m.color || '#5b8def',
        maxTokens: m.maxTokens || 0,
        reasoning: m.reasoning || 'off',
        supportsImages: Boolean(m.supportsImages),
        enabled: m.enabled !== false,
      }));
    }

    if (patch.settings) cfg.settings = Object.assign({}, cfg.settings, patch.settings);

    await idbPut('kv', 'config', cfg);
    return { ok: true };
  }

  async function getConfig() {
    const cfg = await loadConfig();
    return {
      providers: cfg.providers.map((p) => ({
        id: p.id, name: p.name, baseUrl: p.baseUrl,
        hasKey: Boolean(p.apiKeyEnc), models: p.models || [],
      })),
      proxy: cfg.proxy,
      groupPrompt: cfg.groupPrompt,
      kb: cfg.kb,
      members: cfg.members,
      settings: cfg.settings,
    };
  }

  /* ================= 会话 ================= */

  async function getIndex() {
    const idx = (await idbGet('kv', 'sessionIndex')) || { sessions: [], activeId: null };
    if (!Array.isArray(idx.sessions)) idx.sessions = [];
    return idx;
  }
  async function putIndex(idx) {
    await idbPut('kv', 'sessionIndex', idx);
  }

  async function listSessions() {
    const idx = await getIndex();
    return { sessions: idx.sessions, activeId: idx.activeId };
  }

  async function createSession(title, members, kb, groupPrompt, issues) {
    const idx = await getIndex();
    const id = uid();
    const t = (title || '').trim() || '新会话';
    const snapshot = Array.isArray(members) ? JSON.parse(JSON.stringify(members)) : [];
    const kbSnapshot = (kb && typeof kb === 'object')
      ? JSON.parse(JSON.stringify(kb))
      : { enabled: true, budget: 12000, files: [] };
    const gp = typeof groupPrompt === 'string' ? groupPrompt : '';
    const data = { id, title: t, messages: [], members: snapshot, kb: kbSnapshot, groupPrompt: gp, issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : [], createdAt: Date.now(), updatedAt: Date.now() };
    await idbPut('sessions', data);
    idx.sessions.unshift({ id, title: t, messageCount: 0, createdAt: data.createdAt, updatedAt: data.updatedAt });
    idx.activeId = id;
    await putIndex(idx);
    return { id, title: t, messages: [], members: snapshot, kb: kbSnapshot, groupPrompt: gp, issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : [] };
  }

  async function loadSession(id) {
    const s = await idbGet('sessions', id);
    const idx = await getIndex();
    idx.activeId = id;
    await putIndex(idx);
    if (!s) return { id, title: '（已丢失）', messages: [] };
    return s;
  }

  async function saveSession({ id, messages, title, members, kb, groupPrompt, issues }) {
    const old = (await idbGet('sessions', id)) || { id, title: '新会话', messages: [] };
    const data = {
      id,
      title: title || old.title,
      messages: Array.isArray(messages) ? messages : old.messages,
      members: Array.isArray(members) ? JSON.parse(JSON.stringify(members)) : (old.members || []),
      kb: (kb && typeof kb === 'object') ? JSON.parse(JSON.stringify(kb)) : (old.kb || { enabled: true, budget: 12000, files: [] }),
      groupPrompt: typeof groupPrompt === 'string' ? groupPrompt : (old.groupPrompt || ''),
      issues: Array.isArray(issues) ? JSON.parse(JSON.stringify(issues)) : (old.issues || []),
      createdAt: old.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await idbPut('sessions', data);

    const idx = await getIndex();
    const rec = idx.sessions.find((x) => x.id === id);
    if (rec) {
      rec.messageCount = data.messages.length;
      rec.title = data.title;
      rec.updatedAt = data.updatedAt;
    } else {
      idx.sessions.unshift({ id, title: data.title, messageCount: data.messages.length, updatedAt: data.updatedAt });
    }
    await putIndex(idx);
    return { ok: true, count: data.messages.length };
  }

  async function renameSession({ id, title }) {
    const s = (await idbGet('sessions', id)) || { id, messages: [] };
    s.title = (title || '').trim() || '未命名';
    await idbPut('sessions', s);
    const idx = await getIndex();
    const rec = idx.sessions.find((x) => x.id === id);
    if (rec) { rec.title = s.title; rec.updatedAt = Date.now(); }
    await putIndex(idx);
    return { ok: true };
  }

  async function deleteSession(id) {
    await idbDel('sessions', id);
    const idx = await getIndex();
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    if (idx.activeId === id) idx.activeId = idx.sessions[0] ? idx.sessions[0].id : null;
    await putIndex(idx);
    return { ok: true, activeId: idx.activeId };
  }

  async function clearChat() {
    const idx = await getIndex();
    if (idx.activeId) await saveSession({ id: idx.activeId, messages: [] });
    return { ok: true };
  }

  /* ================= 流式请求 ================= */

  const deltaSubs = new Set();
  const controllers = new Map();

  function emitDelta(payload) {
    deltaSubs.forEach((fn) => {
      try { fn(payload); } catch { /* 忽略单个订阅者异常 */ }
    });
  }

  function onDelta(cb) {
    deltaSubs.add(cb);
    return () => deltaSubs.delete(cb);
  }

  async function readStream(res, runId) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let usage = null;
    let finishReason = null;
    let sawDone = false;

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

    // 流结束时的残余数据（最后一行通常没有换行）
    if (buffer.trim()) handleLine(buffer.trim());
    buffer = '';

    function handleLine(line) {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { sawDone = true; return; }
      let json;
      try { json = JSON.parse(payload); } catch { return; }

      if (json.usage) {
        usage = json.usage;
        emitDelta({ runId, type: 'usage', usage });
      }
      const choice = json.choices && json.choices[0];
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = (choice && choice.delta) || {};
      if (delta.reasoning_content) emitDelta({ runId, type: 'reasoning', text: delta.reasoning_content });
      if (delta.content) {
        full += delta.content;
        emitDelta({ runId, type: 'content', text: delta.content });
      }
    }

    return {
      ok: true,
      text: full,
      usage,
      finishReason,
      truncated: finishReason === 'length',
      interrupted: !sawDone && !finishReason,
    };
  }

  async function run(req) {
    const cfg = await loadConfig();
    const provider = cfg.providers.find((p) => p.id === req.providerId) || cfg.providers[0];
    if (!provider) return { ok: false, error: '没有可用的供应商，请先在设置里添加' };
    const apiKey = decodeKey(provider.apiKeyEnc);

    const controller = new AbortController();
    controllers.set(req.runId, controller);

    let msgs = req.messages;
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

    const base = normalizeBase(provider.baseUrl);
    const body = {
      model: req.model,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.7,
    };
    if (req.maxTokens > 0) body.max_tokens = req.maxTokens;
    const wantReasoning = req.reasoning && req.reasoning !== 'off';
    if (wantReasoning) body.reasoning_effort = req.reasoning;

    const headers = {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    try {
      let res = await fetch(base + '/chat/completions', {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        // 服务端不认 reasoning_effort：去掉重试一次
        if (wantReasoning && /reasoning|thinking|unsupported|unknown|invalid/i.test(text)) {
          const retryBody = Object.assign({}, body);
          delete retryBody.reasoning_effort;
          res = await fetch(base + '/chat/completions', {
            method: 'POST', headers, body: JSON.stringify(retryBody), signal: controller.signal,
          });
          if (res.ok) return readStream(res, req.runId);
          return { ok: false, error: 'HTTP ' + res.status + '：' + (await res.text()).slice(0, 300) };
        }
        return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 500) };
      }

      return await readStream(res, req.runId);
    } catch (e) {
      return { ok: false, error: humanError(e) };
    } finally {
      controllers.delete(req.runId);
    }
  }

  function abort(runId) {
    const c = controllers.get(runId);
    if (c) c.abort();
    return { ok: true };
  }

  async function generatePlan(req) {
    const cfg = await loadConfig();
    const provider = cfg.providers.find((p) => p.id === req.providerId) || cfg.providers[0];
    if (!provider) return { ok: false, error: '没有可用的供应商，请先在设置里添加' };
    const apiKey = decodeKey(provider.apiKeyEnc);
    const base = normalizeBase(provider.baseUrl);
    const body = {
      model: req.model,
      messages: req.messages,
      temperature: 0.3,
    };
    if (req.maxTokens > 0) body.max_tokens = req.maxTokens;
    if (req.json !== false) body.response_format = { type: 'json_object' };

    const headers = {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    };
    try {
      let res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        let text = await res.text();
        if (body.response_format && /response_format|json_object|unsupported|invalid|unknown/i.test(text)) {
          delete body.response_format;
          res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
          if (res.ok) {
            const d2 = await res.json();
            return { ok: true, text: d2.choices?.[0]?.message?.content || '', usage: d2.usage || null };
          }
          text = await res.text();
        }
        return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 500) };
      }
      const data = await res.json();
      return { ok: true, text: data.choices?.[0]?.message?.content || '', usage: data.usage || null };
    } catch (e) {
      return { ok: false, error: humanError(e) };
    }
  }

  async function listModels(providerId, apiKey) {
    const cfg = await loadConfig();
    const provider = cfg.providers.find((p) => p.id === providerId) || cfg.providers[0];
    if (!provider) throw new Error('还没有配置供应商');
    const base = normalizeBase(provider.baseUrl);
    const key = apiKey || decodeKey(provider.apiKeyEnc);
    let res;
    try {
      res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
    } catch (e) {
      throw new Error(humanError(e));
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const items = data.data || data.models || [];
    return items.map((m) => {
      if (typeof m === 'string') return m.trim();
      const id = m.id ? String(m.id).trim() : '';
      const name = m.name ? String(m.name).trim() : '';
      const display = m.display_name ? String(m.display_name).trim() : '';
      if (id && /^[a-zA-Z][\w.\-+]*$/.test(id)) return id;
      return name || display || id;
    }).filter(Boolean).sort();
  }

  /* ================= 知识库 ================= */

  const fileMap = new Map(); // 虚拟路径 -> File

  function isImage(name) {
    return /\.(png|jpe?g|webp|bmp|gif)$/i.test(name);
  }

  /** 把 File 列表登记进来，返回虚拟路径数组 */
  function registerFiles(files) {
    const paths = [];
    for (const f of files || []) {
      const id = `file:${f.name}:${f.size}:${f.lastModified || 0}`;
      fileMap.set(id, f);
      paths.push(id);
    }
    return paths;
  }

  function kbPick() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const finish = (paths) => {
        if (settled) return;
        settled = true;
        input.remove();
        window.removeEventListener('focus', onFocus);
        resolve(paths);
      };
      const onFocus = () => {
        // 用户取消时不会触发 change，用窗口重新获得焦点兜底
        setTimeout(() => finish([]), 600);
      };

      input.onchange = () => finish(registerFiles(Array.from(input.files)));

      window.addEventListener('focus', onFocus, { once: true });
      input.click();
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error);
      r.readAsText(file, 'utf-8');
    });
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  let pdfLib = null;
  async function getPdfLib() {
    if (pdfLib) return pdfLib;
    pdfLib = await import('./vendor/pdf.min.mjs');
    pdfLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    return pdfLib;
  }

  async function extractPdfText(file) {
    const lib = await getPdfLib();
    const buf = await readAsArrayBuffer(file);
    const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => it.str).join(' '));
    }
    try { doc.destroy(); } catch { /* 忽略 */ }
    return parts.join('\n\n');
  }

  /** 尽量把字节解成正确的中文：BOM → UTF-16 → UTF-8 → GB18030/GBK/Big5 */
  function decodeBytes(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      try { return new TextDecoder('utf-16le').decode(bytes); } catch { /* 继续 */ }
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      try { return new TextDecoder('utf-16be').decode(bytes); } catch { /* 继续 */ }
    }
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const bad = (utf8.match(/\uFFFD/g) || []).length;
    if (!bad) return utf8;
    for (const enc of ['gb18030', 'gbk', 'big5']) {
      try {
        const alt = new TextDecoder(enc).decode(bytes);
        const altBad = (alt.match(/\uFFFD/g) || []).length;
        if (altBad < bad) return alt;
      } catch { /* 该编码不可用 */ }
    }
    return utf8;
  }

  async function readAsTextSmart(file) {
    const buf = await readAsArrayBuffer(file);
    return decodeBytes(buf);
  }

  /* ---------- EPUB（ZIP + XHTML，用浏览器自带 DecompressionStream） ---------- */

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持解压（请用新版 Chrome / Edge）');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function zipEntries(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB（找不到 ZIP 目录）');
    const count = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const out = new Map();

    for (let n = 0; n < count; n++) {
      if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOff = view.getUint32(ptr + 42, true);
      const name = new TextDecoder('utf-8').decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;

      try {
        if (view.getUint32(localOff, true) !== 0x04034b50) continue;
        const lNameLen = view.getUint16(localOff + 26, true);
        const lExtraLen = view.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = bytes.subarray(start, start + compSize);
        if (method === 0) out.set(name, raw);
        else if (method === 8) out.set(name, await inflateRaw(raw));
      } catch { /* 单个文件跳过 */ }
    }
    return out;
  }

  function epubStrip(html) {
    let t = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|figcaption)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
    return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function extractEpub(file) {
    const files = await zipEntries(await readAsArrayBuffer(file));
    const dec = (u8) => (u8 ? decodeBytes(u8) : '');
    const get = (p) => {
      if (!p) return null;
      const k = String(p).replace(/^\//, '');
      return files.get(k) || files.get(decodeURIComponent(k)) || null;
    };

    const container = dec(get('META-INF/container.xml'));
    const m = container.match(/<rootfile[^>]+full-path="([^"]+)"/i);
    if (!m) throw new Error('EPUB 结构异常：找不到 OPF 描述文件');
    const opfPath = m[1];
    const opfDir = (opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '');
    const opf = dec(get(opfPath));
    if (!opf) throw new Error('EPUB 结构异常：OPF 为空');

    const manifest = new Map();
    for (const mm of opf.matchAll(/<item\b[^>]*>/gi)) {
      const tag = mm[0];
      const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
      const href = (tag.match(/\bhref="([^"]+)"/) || [])[1];
      const mt = (tag.match(/\bmedia-type="([^"]+)"/) || [])[1] || '';
      if (id && href) manifest.set(id, { href, mt });
    }

    const order = [];
    for (const mm of opf.matchAll(/<itemref\b[^>]*>/gi)) {
      const idref = (mm[0].match(/\bidref="([^"]+)"/) || [])[1];
      if (idref && manifest.has(idref)) order.push(manifest.get(idref));
    }

    const title = epubStrip((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '');
    const parts = [];
    const seen = new Set();

    for (const item of order) {
      if (!/xhtml|html/i.test(item.mt)) continue;
      const rel = opfDir ? opfDir + '/' + item.href : item.href;
      const buf = get(rel);
      if (!buf) continue;
      const html = dec(buf);
      if (seen.has(html)) continue;
      seen.add(html);
      let chTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      if (!chTitle) chTitle = (html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || '';
      chTitle = epubStrip(chTitle).slice(0, 60);
      const text = epubStrip(html);
      if (text) parts.push({ title: chTitle, text });
    }

    if (!parts.length) {
      const list = [];
      for (const [name, u8] of files) {
        if (!/\.(xhtml|html|htm)$/i.test(name)) continue;
        const text = epubStrip(dec(u8));
        if (text) list.push({ title: name, text });
      }
      list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
      parts.push(...list.slice(0, 500));
    }
    if (!parts.length) throw new Error('EPUB 里没有可读的章节文本');

    const MAX = 3000000;
    let body = '';
    let cut = 0;
    for (let i = 0; i < parts.length; i++) {
      const seg = `\n\n【第 ${i + 1} 节｜${parts[i].title || '无标题'}】\n${parts[i].text}`;
      if (body.length + seg.length > MAX) { cut = parts.length - i; break; }
      body += seg;
    }
    const toc = parts.map((p, i) => `${i + 1}. ${p.title || '无标题'}`);
    const head = (title ? `【书名】${title}\n` : '')
      + `【格式】EPUB，共 ${parts.length} 节，提取 ${body.length} 字符\n【目录】\n${toc.join('\n')}`;
    return head + '\n' + body + (cut ? `\n\n（达到单本提取上限，最后 ${cut} 节未包含）` : '');
  }

  async function parseFile(file) {
    const name = file.name.toLowerCase();
    if (isImage(file.name)) return '';
    if (name.endsWith('.pdf')) return extractPdfText(file);
    if (name.endsWith('.docx')) {
      if (!window.mammoth) throw new Error('Word 解析库未加载');
      const buf = await readAsArrayBuffer(file);
      const r = await window.mammoth.extractRawText({ arrayBuffer: buf });
      return r.value || '';
    }
    if (name.endsWith('.doc')) throw new Error('旧版 .doc 不支持，请另存为 .docx');
    if (name.endsWith('.epub')) return extractEpub(file);
    if (name.endsWith('.mobi') || name.endsWith('.azw3') || name.endsWith('.azw')) {
      throw new Error('暂不支持该格式，请先转成 .epub 或导出 .txt');
    }
    return readAsTextSmart(file);
  }

  async function kbIndex(paths) {
    const out = [];
    for (const path of paths || []) {
      const file = fileMap.get(path);
      if (!file) {
        out.push({ path, name: (path || '').split(':')[1] || path, kind: 'doc', ok: false, chars: 0, error: '文件已失效，请重新添加' });
        continue;
      }
      const kind = isImage(file.name) ? 'image' : 'doc';
      try {
        const text = await parseFile(file);
        if (kind === 'doc') await idbPut('kbcache', path, text);
        out.push({ path, name: file.name, kind, ok: true, chars: text.length });
      } catch (e) {
        out.push({ path, name: file.name, kind, ok: false, chars: 0, error: String(e.message || e) });
      }
    }
    return out;
  }

  /** 压缩图片，避免请求过大 */
  async function shrinkImage(file, maxSide = 1280) {
    const dataUrl = await readAsDataURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = dataUrl;
      });
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1) return dataUrl;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return dataUrl;
    }
  }

  /** 用视觉模型把图片转成文字（给不支持看图的成员用） */
  async function ocrWithModel(dataUrl, ocr) {
    const cfg = await loadConfig();
    const provider = cfg.providers.find((p) => p.id === ocr.providerId) || cfg.providers[0];
    if (!provider) throw new Error('没有可用供应商做 OCR');
    const base = normalizeBase(provider.baseUrl);
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + decodeKey(provider.apiKeyEnc), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ocr.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请把这张图片里的文字完整、按原顺序转写出来，不要解释、不要总结、不要补充。如果图中没有文字，只回复：（无文字）' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 2000,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error('OCR HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));

    const raw = await res.text();
    const trimmed = raw.trim();

    // 有些服务商无视 stream:false，仍然流式返回，这里都兼容
    if (trimmed.startsWith('data:')) {
      let text = '';
      for (const line of trimmed.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) text += d.content;
        } catch { /* 忽略 */ }
      }
      return text;
    }

    const json = JSON.parse(trimmed);
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }

  const CHUNK_SIZE = 800;
  const CHUNK_OVERLAP = 120;

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
      while ((idx = low.indexOf(t, idx)) >= 0 && hits < 12) { hits++; idx += t.length; }
      if (hits) score += hits * (t.length >= 2 ? 1 : 0.4);
    }
    return score;
  }

  async function kbDigest({ files, budget = 40000 }) {
    const docs = (files || []).filter((f) => f.kind !== 'image');
    const images = (files || []).filter((f) => f.kind === 'image');
    const out = [];
    let used = 0;
    const perFile = Math.max(1000, Math.min(4000, Math.floor(budget / Math.max(docs.length, 1))));
    for (const f of docs) {
      if (used >= budget) break;
      try {
        const text = String((await idbGet('kbcache', f.path)) || '')
          .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (!text) { out.push({ name: f.name, chars: 0, head: '', tail: '' }); continue; }
        const remain = budget - used;
        const head = text.slice(0, Math.min(perFile, remain));
        let tail = '';
        if (text.length > head.length + 400 && remain - head.length > 400) {
          tail = text.slice(-Math.min(1200, remain - head.length));
          if (tail.length < 100) tail = '';
        }
        used += head.length + tail.length;
        out.push({ name: f.name, chars: text.length, head, tail });
      } catch (e) {
        out.push({ name: f.name, chars: 0, head: '', tail: '', error: String(e.message || e) });
      }
    }
    return { files: out, images: images.map((f) => ({ name: f.name })), used, docCount: docs.length };
  }

  /* ---- 材料清单 + 按文件注入（与桌面版一致） ---- */

  function fileOutline(name, text) {
    const ext = ('.' + String(name).split('.').pop()).toLowerCase();
    const lines = String(text).split('\n');
    const hits = [];
    const MAX = 80;
    const add = (i, l) => { if (hits.length < MAX) hits.push(`${i + 1}: ${l.trim().slice(0, 110)}`); };

    const norm = ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? '.js'
      : ext === '.tsx' ? '.ts' : ext === '.htm' ? '.html' : ext;

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
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t && t.length <= 60 && /^(第[一二三四五六七八九十百]+[章节条]|[一二三四五六七八九十]+、|\(?\d+[.、)]|[A-Z][A-Za-z ]{2,30}:?$)/.test(t)) add(i, t);
    });
    return hits;
  }

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
      `⚠ 共 ${totalLines} 行；此处注入了第 1–${headLines.length} 行、结构大纲、${windows.length} 段中段采样` +
      (tailLines.length ? `和第 ${startTail}–${totalLines} 行` : '') +
      `，合计约 ${injected} 行，其余 ${missing} 行未注入。**未注入不等于不存在**。`
    );
    return { block: parts.join('\n'), full: false, injected, totalLines };
  }

  function buildKbBlocks(items, budget, focus) {
    const inventory = items.map((it) => ({
      name: it.entry.name,
      lines: it.text.split('\n').length,
      chars: it.text.length,
    }));

    const alloc = new Map();
    let primary = items;
    let secondary = [];

    const terms = queryTerms(focus || '');
    if (terms.length && items.length > 1) {
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
          if (d === 0 || d === N) continue;
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
        return { it, hits, density: hits / Math.log2(it.text.length + 2) };
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
    if (pending.length) {
      const weights = pending.map((it) => Math.sqrt(it.text.length));
      const wsum = weights.reduce((a, b) => a + b, 0) || 1;
      const left = Math.max(pool, 0);
      const minEach = Math.min(1500, Math.floor(Math.max(left, 1) * 0.3 / pending.length) || 800);
      pending.forEach((it, i) => {
        let share = Math.floor(left * (weights[i] / wsum));
        if (share < minEach) share = Math.min(minEach, it.text.length);
        alloc.set(it.entry.path, Math.min(share, it.text.length));
      });
    }
    if (secondary.length) {
      const each = Math.max(600, Math.floor(secondaryBudget / secondary.length));
      for (const it of secondary) alloc.set(it.entry.path, Math.min(each, it.text.length));
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
      inventory,
      truncated,
      focused: primary.map((it) => it.entry.name),
      totalChars: items.reduce((a, b) => a + b.text.length, 0),
    };
  }

  async function kbContext({ files, budget = 12000, wantImages = false, ocr = null, query = '', focus = '' }) {
    const docs = (files || []).filter((f) => f.kind !== 'image');
    const images = (files || []).filter((f) => f.kind === 'image');
    const parts = [];
    let used = 0;
    let skipped = 0;

    // 材料清单 + 按文件保证注入
    const items = [];
    for (const f of docs) {
      const text = String((await idbGet('kbcache', f.path)) || '')
        .replace(/\r\n/g, '\n').trim();
      if (!text) { skipped++; continue; }
      items.push({ entry: f, text });
    }
    const picked = buildKbBlocks(items, budget, focus || query);
    parts.push(picked.text);
    used += picked.used;

    const imagePayload = [];
    if (wantImages) {
      for (const f of images.slice(0, 10)) {
        const file = fileMap.get(f.path);
        if (!file) { skipped++; continue; }
        try {
          imagePayload.push({ name: f.name, url: await shrinkImage(file) });
        } catch { skipped++; }
      }
    } else if (ocr) {
      for (const f of images) {
        const remain = budget - used;
        if (remain <= 100) break;
        const cacheKey = f.path + '::ocr::' + ocr.model;
        let text = (await idbGet('kbcache', cacheKey)) || '';
        if (!text) {
          const file = fileMap.get(f.path);
          if (!file) { skipped++; continue; }
          try {
            const dataUrl = await shrinkImage(file);
            emitDelta({ runId: '__ocr__', type: 'reasoning', text: `正在用 ${ocr.model} 识别图片：${f.name}\n` });
            text = await ocrWithModel(dataUrl, ocr);
            await idbPut('kbcache', cacheKey, text);
          } catch (e) {
            skipped++;
            continue;
          }
        }
        const clean = String(text).trim();
        if (!clean) continue;
        const slice = clean.slice(0, remain);
        parts.push(`【图片转写：${f.name}】\n${slice}`);
        used += slice.length;
      }
    } else {
      skipped += images.length;
    }

    return {
      text: parts.join('\n\n'),
      used,
      skipped,
      inventory: picked.inventory || [],
      truncated: picked.truncated || [],
      focused: picked.focused || [],
      totalChars: picked.totalChars || 0,
      docCount: docs.length,
      imageCount: images.length,
      images: imagePayload,
    };
  }

  /* ================= 联网搜索（r.jina.ai） ================= */

  const JINA = 'https://r.jina.ai/';

  async function jina(targetUrl) {
    const res = await fetch(JINA + targetUrl, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('抓取服务 HTTP ' + res.status);
    return await res.text();
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseRss(xml) {
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && out.length < 10) {
      const body = m[1];
      const title = decodeXml((body.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = decodeXml((body.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const desc = decodeXml((body.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
      if (!/^https?:\/\//i.test(link)) continue;
      if (!title) continue;
      out.push({ title, url: link, snippet: desc.slice(0, 300) });
    }
    return out;
  }

  /** 解析 jina 输出的 Markdown：`### [标题](链接)` + 下一段作为摘要 */
  function parseJinaMarkdown(md) {
    const lines = String(md).split('\n');
    const out = [];
    const seen = new Set();

    for (let i = 0; i < lines.length && out.length < 10; i++) {
      const line = lines[i].trim();
      const m = line.match(/^#{2,4}\s*\[([^\]]{2,150})\]\((https?:\/\/[^)\s]+)\)/);
      if (!m) continue;

      const title = m[1].trim();
      const url = m[2];
      if (/bing\.com|microsoft\.com|msn\.com|w3\.org/i.test(url)) continue;
      if (seen.has(url)) continue;

      let snippet = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (/^#{1,6}\s/.test(t)) break;
        if (/^\[[^\]]*\]\([^)]*\)$/.test(t)) break;
        snippet = t;
        break;
      }

      seen.add(url);
      out.push({ title, url, snippet: snippet.slice(0, 300) });
    }
    return out;
  }

  function parseLinks(markdown) {
    const out = [];
    const seen = new Set();
    const re = /\[([^\]]{2,120})\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(markdown)) && out.length < 12) {
      const url = m[2];
      if (/bing\.com|microsoft\.com|msn\.com|go\.microsoft|w3\.org/i.test(url)) continue;
      if (/许可证|备案|隐私|条款|关于我们|京ICP|沪ICP/i.test(m[1])) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: m[1].trim(), url, snippet: '' });
    }
    return out;
  }

  async function webSearch({ query, fetchPages = 3, maxChars = 1500 }) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: '空查询', results: [], pages: [] };

    let results = [];
    const errors = [];

    // 1) Bing RSS（jina 会转成 Markdown）：标题/摘要/链接都有，最干净
    try {
      const md = await jina('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q));
      results = parseJinaMarkdown(md);
      if (!results.length) results = parseRss(md);
      if (!results.length) errors.push('bing-rss: 无结果');
    } catch (e) {
      errors.push('bing-rss: ' + String(e.message || e).slice(0, 80));
    }

    // 2) 退化为普通搜索结果页链接解析
    if (!results.length) {
      try {
        const md = await jina('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN');
        results = parseJinaMarkdown(md);
        if (!results.length) results = parseLinks(md);
        if (!results.length) errors.push('bing: 无结果');
      } catch (e) {
        errors.push('bing: ' + String(e.message || e).slice(0, 80));
      }
    }

    // 3) 再退化为 DuckDuckGo
    if (!results.length) {
      try {
        const md = await jina('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
        results = parseLinks(md);
        if (!results.length) errors.push('ddg: 无结果');
      } catch (e) {
        errors.push('ddg: ' + String(e.message || e).slice(0, 80));
      }
    }

    if (!results.length) {
      return { ok: false, error: errors.join(' | ') || '搜索不可用', results: [], pages: [] };
    }

    const pages = [];
    for (const r of results.slice(0, fetchPages)) {
      try {
        const md = await jina(r.url);
        const body = md.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
        if (body.length > 80) pages.push({ title: r.title, url: r.url, content: body.slice(0, maxChars) });
      } catch { /* 单条失败忽略 */ }
    }

    return { ok: true, source: 'r.jina.ai', results: results.slice(0, 8), pages, error: null };
  }

  /* ================= 导出 ================= */

  async function exportMarkdown({ content, defaultName }) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName || 'think-tank.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    return { ok: true, path: '浏览器下载目录' };
  }

  /* ================= 杂项 ================= */

  async function diagDump(info) {
    return { ok: false, path: '（网页版：诊断信息见控制台）', info };
  }

  async function refocus() {
    try { window.focus(); } catch { /* 忽略 */ }
    return { ok: document.hasFocus() };
  }

  /* ================= 暴露 ================= */

  const APP_VERSION = '0.4.6';
  const REPO = 'https://github.com/Thams94/think-tank';

  window.api = {
    appInfo: async () => ({
      version: APP_VERSION,
      engine: '浏览器版',
      releases: REPO + '/releases/latest',
      repo: REPO,
      dataDir: null,
    }),
    openExternal: async (url) => {
      if (!/^https:\/\/github\.com\/Thams94\//.test(String(url || ''))) return { ok: false };
      window.open(url, '_blank', 'noopener');
      return { ok: true };
    },
    getConfig, saveConfig,
    listModels,
    generatePlan,
    decideModerator: generatePlan,
    run, abort, onDelta,
    kbPick, kbIndex, kbContext, kbDigest,
    kbAddFiles: async (files) => registerFiles(files),
    kbPickFolder: async () => kbPick(),
    kbScanFolder: async () => ({ paths: [], truncated: false }),
    kbCacheInfo: async () => {
      let count = 0;
      try {
        await new Promise((res) => {
          openDb().then((db) => {
            const t = db.transaction('kbcache', 'readonly');
            const q = t.objectStore('kbcache').count();
            q.onsuccess = () => { count = q.result || 0; res(); };
            q.onerror = () => res();
          }).catch(() => res());
        });
      } catch { /* 忽略 */ }
      return { count, bytes: 0, dir: '浏览器 IndexedDB' };
    },
    kbClearCache: async () => {
      try {
        await new Promise((res) => {
          openDb().then((db) => {
            const t = db.transaction('kbcache', 'readwrite');
            t.objectStore('kbcache').clear();
            t.oncomplete = () => res();
            t.onerror = () => res();
          }).catch(() => res());
        });
      } catch { /* 忽略 */ }
      return { ok: true };
    },
    openPath: async () => ({ ok: false }),
    showContextMenu: async () => ({ ok: false }),
    rankingCache: async () => {
      try {
        const r = await fetch('./data/ranking.json', { cache: 'no-store' });
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        const j = await r.json();
        return Object.assign({ ok: true }, j);
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    rankingFetch: async () => {
      try {
        const r = await fetch('./data/ranking.json', { cache: 'no-store' });
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
        const j = await r.json();
        return Object.assign({ ok: true }, j);
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    webSearch,
    exportMarkdown,
    diagDump, refocus,
    diagNote: async () => ({ ok: false }),
    listSessions, createSession, loadSession, saveSession, renameSession, deleteSession,
    loadChat: async () => ({ messages: [] }),
    saveChat: async () => ({ ok: true }),
    clearChat,
  };

  console.log('[web-bridge] 就绪');
})();
