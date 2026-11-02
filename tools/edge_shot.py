"""截图网页版界面。"""
import base64
import json
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
    "--no-first-run", "--no-default-browser-check",
    "--window-size=1400,900", "http://127.0.0.1:8788/",
])
time.sleep(7)

try:
    page = next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
                if t["type"] == "page" and "8788" in t["url"])
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
    seq = 0

    def send(method, params=None):
        global seq
        seq += 1
        mid = seq
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def wait(mid, wait_ms=30000):
        end = time.time() + wait_ms / 1000
        while time.time() < end:
            m = json.loads(ws.recv())
            if m.get("id") == mid:
                return m.get("result", {})
        return {}

    def ev(expr, wait_ms=30000):
        r = wait(send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True}), wait_ms)
        return r.get("result", {}).get("value")

    # 造几条对话，便于展示
    ev("""
(async () => {
  if (state.members.length < 2) {
    await bridge.saveConfig({
      members: [
        { id: 'mA', name: '分析员', providerId: (state.providers[0]||{}).id, model: 'mock-ok', persona: '先给结论再给理由', temp: 0.6, color: '#5b8def', enabled: true },
        { id: 'mB', name: '评审员', providerId: (state.providers[0]||{}).id, model: 'mock-ok', persona: '专门找漏洞', temp: 0.8, color: '#e06c5b', enabled: true }
      ]
    });
    const cfg = await bridge.getConfig();
    state.members = cfg.members;
  }
  renderAll();
  return 'ok';
})()
""")
    time.sleep(0.5)
    ev("document.querySelector('#input').value = '@分析员 帮我看看这个方案的风险'; send(); 'ok'")
    for _ in range(30):
        if ev("state.running") is False:
            break
        time.sleep(0.5)
    time.sleep(0.8)

    r = wait(send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}), 20000)
    data = r.get("data")
    if data:
        with open(r"D:\Harness\evidence\web-v1.png", "wb") as f:
            f.write(base64.b64decode(data))
        print("截图已保存: D:\\Harness\\evidence\\web-v1.png")
    else:
        print("截图失败", r)
    ws.close()
finally:
    proc.terminate()
