'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置（含多供应商）
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  // 模型列表：按供应商
  listModels: (providerId, apiKey) => ipcRenderer.invoke('models:list', providerId, apiKey),

  // 联网搜索
  webSearch: (payload) => ipcRenderer.invoke('websearch:run', payload),

  // 知识库
  // 系统交互
  showContextMenu: (opts) => ipcRenderer.send('menu:context', opts),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  kbPick: () => ipcRenderer.invoke('kb:pick'),
  kbPickFolder: () => ipcRenderer.invoke('kb:pickFolder'),
  kbScanFolder: (dir) => ipcRenderer.invoke('kb:scanFolder', dir),
  kbCacheInfo: () => ipcRenderer.invoke('kb:cacheInfo'),
  kbClearCache: () => ipcRenderer.invoke('kb:clearCache'),
  kbIndex: (paths) => ipcRenderer.invoke('kb:index', paths),
  kbContext: (payload) => ipcRenderer.invoke('kb:context', payload),
  kbDigest: (payload) => ipcRenderer.invoke('kb:digest', payload),

  // 会话
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (title, members, kb, groupPrompt) => ipcRenderer.invoke('sessions:create', title, members, kb, groupPrompt),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (payload) => ipcRenderer.invoke('sessions:save', payload),
  renameSession: (payload) => ipcRenderer.invoke('sessions:rename', payload),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  // 聊天记录（旧接口，保留兼容）
  loadChat: () => ipcRenderer.invoke('chat:load'),
  saveChat: (data) => ipcRenderer.invoke('chat:save', data),
  clearChat: () => ipcRenderer.invoke('chat:clear'),

  // 导出
  exportMarkdown: (payload) => ipcRenderer.invoke('export:markdown', payload),

  // 诊断
  diagDump: (info) => ipcRenderer.invoke('diag:dump', info),

  // 强制激活窗口（修复原生对话框后失焦）
  refocus: () => ipcRenderer.invoke('win:refocus'),

  // 单次生成
  run: (req) => ipcRenderer.invoke('chat:run', req),
  generatePlan: (req) => ipcRenderer.invoke('plan:generate', req),
  decideModerator: (req) => ipcRenderer.invoke('plan:generate', req),
  abort: (runId) => ipcRenderer.invoke('chat:abort', runId),

  onDelta: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:delta', h);
    return () => ipcRenderer.removeListener('chat:delta', h);
  },
  onDone: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:done', h);
    return () => ipcRenderer.removeListener('chat:done', h);
  },
  onError: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:error', h);
    return () => ipcRenderer.removeListener('chat:error', h);
  },
});
