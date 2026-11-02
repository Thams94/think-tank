"""验证网页版知识库（真实文件 + CDP 置入）与联网搜索。"""
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
KB = r"D:\Harness\ai-group-chat-web\.testfiles"

proc = subprocess.Popen([
    EDGE, f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
    "--no-first-run", "--no-default-browser-check", "http://127.0.0.1:8788/",
])
time.sleep(6)

try:
    page = next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
                if t["type"] == "page" and "8788" in t["url"])
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=90, suppress_origin=True)
    seq = 0

    def send(method, params=None):
        global seq
        seq += 1
        mid = 9000 + seq
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def wait(mid, wait_ms=60000):
        end = time.time() + wait_ms / 1000
        while time.time() < end:
            m = json.loads(ws.recv())
            if m.get("id") == mid:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return "EXC:" + str(r["exceptionDetails"])[:400]
                return r.get("result", {}).get("value") if "result" in r else r
        return "TIMEOUT"

    def ev(expr, wait_ms=60000):
        return wait(send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}), wait_ms)

    print("页面:", ev("document.title"))

    # ---- 知识库：点击添加按钮（无需真弹窗，直接调 bridge 并置入文件）----
    ev("window.__kbPromise = bridge.kbPick(); 'started'")
    time.sleep(0.8)

    doc = send("DOM.getDocument", {"depth": -1})
    root_id = wait(doc)["root"]["nodeId"]
    q = wait(send("DOM.querySelector", {"nodeId": root_id, "selector": "input[type=file]"}))
    print("文件输入节点:", q)

    files = [os.path.join(KB, n) for n in sorted(os.listdir(KB))]
    print("置入文件:", [os.path.basename(f) for f in files])

    wait(send("DOM.setFileInputFiles", {"nodeId": q, "files": files}))
    time.sleep(1.5)

    print("kbPick 返回路径数:", ev("window.__kbPromise.then(p => p.length)"))

    print("\n[知识库解析]")
    print(ev("""
(async () => {
  const paths = await window.__kbPromise;
  const entries = await bridge.kbIndex(paths);
  state.kb.files = entries;
  return JSON.stringify(entries.map(e => ({ n: e.name, kind: e.kind, ok: e.ok, chars: e.chars, err: e.error || null })));
})()
"""))

    print("\n[组装上下文：纯文本成员]")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({ files: state.kb.files, budget: 12000, wantImages: false, ocr: null });
  return JSON.stringify({ used: ctx.used, docs: ctx.docCount, imgs: ctx.imageCount, skipped: ctx.skipped,
    head: ctx.text.slice(0, 150) });
})()
"""))

    print("\n[组装上下文：视觉成员（应有图片）]")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({ files: state.kb.files, budget: 12000, wantImages: true });
  return JSON.stringify({ images: (ctx.images||[]).length, bytes: (ctx.images||[])[0] ? ctx.images[0].url.length : 0 });
})()
"""))

    print("\n[组装上下文：非视觉成员 + 视觉模型 OCR]")
    print(ev("""
(async () => {
  const ctx = await bridge.kbContext({
    files: state.kb.files, budget: 12000, wantImages: false,
    ocr: { providerId: 'mock', model: 'mock-ok' }
  });
  return JSON.stringify({ used: ctx.used, hasOcrBlock: ctx.text.includes('图片转写'),
    sample: (ctx.text.match(/【图片转写：[^】]+】\\n([\\s\\S]{0,60})/) || [])[1] || null });
})()
""", 120000))

    print("\n[联网搜索]")
    print(ev("bridge.webSearch({ query: '2026年放假安排', fetchPages: 1, maxChars: 300 }).then(r => JSON.stringify({ ok: r.ok, src: r.source, n: (r.results||[]).length, pages: (r.pages||[]).length, err: r.error, first: (r.results||[])[0] ? r.results[0].title : null }))", 120000))

    ws.close()
finally:
    proc.terminate()
