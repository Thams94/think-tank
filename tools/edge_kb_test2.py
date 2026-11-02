"""验证网页版知识库解析（通过 kbAddFiles + fetch 本地文件）与搜索。"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9339
PROFILE = r"D:\Harness\ai-group-chat-web\.edge-profile"

proc = subprocess.Popen([
    EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
    "--no-first-run", "--no-default-browser-check", "http://127.0.0.1:8788/",
])
time.sleep(6)

try:
    page = next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
                if t["type"] == "page" and "8788" in t["url"])
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
    seq = 0
    errors = []
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable", "params": {}}))
    time.sleep(0.3)

    def ev(expr, wait_ms=120000):
        global seq
        seq += 1
        mid = 5000 + seq
        ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
        end = time.time() + wait_ms / 1000
        while time.time() < end:
            m = json.loads(ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                errors.append(str((d.get("exception") or {}).get("description", d.get("text")))[:300])
            if m.get("id") == mid:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return "EXC:" + str(r["exceptionDetails"])[:500]
                return r.get("result", {}).get("value")
        return "TIMEOUT"

    print("页面:", ev("document.title"), "| bridge:", ev("typeof window.api"))

    print("\n[0] 准备配置（mock 供应商 + 一个视觉成员）")
    print(ev("""
(async () => {
  await bridge.saveConfig({
    providers: [{ id: 'mock', name: 'mock', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'test' }],
    members: [
      { id: 'mA', name: 'A', providerId: 'mock', model: 'mock-ok', supportsImages: false, persona: '', temp: 0.7, color: '#5b8def', enabled: true },
      { id: 'mV', name: 'V', providerId: 'mock', model: 'mock-ok', supportsImages: true, persona: '', temp: 0.7, color: '#e06c5b', enabled: true }
    ],
    settings: { mode: 'manual', rounds: 1 }
  });
  const cfg = await bridge.getConfig();
  state.members = cfg.members;
  return JSON.stringify(cfg.members.map(m => m.name + ':' + m.supportsImages));
})()
"""))

    print("\n[1] 加载测试文件并登记")
    print(ev("""
(async () => {
  const names = ['差旅报销标准.txt', '项目说明.docx', '项目预算.pdf', 'ocr-test.png'];
  const files = [];
  for (const n of names) {
    const r = await fetch('/.testfiles/' + encodeURIComponent(n));
    if (!r.ok) { files.push(n + ':404'); continue; }
    const blob = await r.blob();
    files.push(new File([blob], n, { type: blob.type, lastModified: 1700000000000 }));
  }
  window.__files = files;
  return files.map(f => f.name + ':' + f.size).join(' | ');
})()
"""))

    print("\n[2] 解析（pdf/docx/txt/png）")
    print(ev("""
(async () => {
  const paths = await bridge.kbAddFiles(window.__files);
  const entries = await bridge.kbIndex(paths);
  state.kb.files = entries;
  return JSON.stringify(entries.map(e => ({ n: e.name, kind: e.kind, ok: e.ok, chars: e.chars, err: e.error || null })));
})()
"""))

    print("\n[3] 上下文：文本成员（无 OCR）")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({ files: state.kb.files, budget: 12000, wantImages: false, ocr: null });
  return JSON.stringify({ used: ctx.used, docs: ctx.docCount, imgs: ctx.imageCount, skipped: ctx.skipped,
    head: ctx.text.slice(0, 120) });
})()
"""))

    print("\n[4] 上下文：视觉成员（应带图片）")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({ files: state.kb.files, budget: 12000, wantImages: true });
  return JSON.stringify({ images: (ctx.images||[]).length, size: (ctx.images||[])[0] ? (ctx.images[0].url.length/1024).toFixed(0) + 'KB' : null });
})()
"""))

    print("\n[5] 上下文：非视觉成员 + 视觉模型 OCR")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({
    files: state.kb.files, budget: 12000, wantImages: false,
    ocr: { providerId: 'mock', model: 'mock-ok' }
  });
  return JSON.stringify({ used: ctx.used, hasOcrBlock: ctx.text.includes('图片转写'),
    sample: (ctx.text.match(/【图片转写：[^】]+】\\n([\\s\\S]{0,50})/) || [])[1] || null });
})()
"""))

    print("\n[6] 联网搜索")
    print(ev("bridge.webSearch({ query: '2026年放假安排', fetchPages: 1, maxChars: 300 }).then(r => JSON.stringify({ ok: r.ok, src: r.source, n: (r.results||[]).length, pages: (r.pages||[]).length, err: r.error, first: (r.results||[])[0] ? r.results[0].title.slice(0,40) : null }))", 150000))

    print("\n控制台异常:", errors[:3] or "无")
    ws.close()
finally:
    proc.terminate()
