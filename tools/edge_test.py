"""用 Edge 自动化验证网页版：加载、配置、流式对话、会话、搜索接口。"""
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
    EDGE,
    f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeSidebarV2",
    "http://127.0.0.1:8788/",
])

time.sleep(6)

try:
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
    page = next(t for t in targets if t["type"] == "page" and "8788" in t["url"])
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
    seq = 0
    errors = []
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable", "params": {}}))
    ws.send(json.dumps({"id": 2, "method": "Log.enable", "params": {}}))
    time.sleep(0.5)

    def ev(expr, wait_ms=30000):
        global seq
        seq += 1
        mid = 1000 + seq
        ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                            "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
        end = time.time() + wait_ms / 1000
        while time.time() < end:
            m = json.loads(ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                errors.append(str((d.get("exception") or {}).get("description", d.get("text")))[:300])
            if m.get("method") == "Log.entryAdded":
                e = m["params"]["entry"]
                if e.get("level") == "error":
                    errors.append("LOG: " + str(e.get("text"))[:200])
            if m.get("id") == mid:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return "EXC:" + str(r["exceptionDetails"])[:400]
                return r.get("result", {}).get("value")
        return "TIMEOUT"

    print("页面标题:", ev("document.title"))
    print("bridge 存在:", ev("typeof window.api"))
    print("方法数:", ev("Object.keys(window.api).length"))
    print("成员数:", ev("state.members.length"))
    print("会话数:", ev("state.sessions.length"))

    print("\n[1] 配置 mock 供应商")
    print(ev("""
(async () => {
  await bridge.saveConfig({
    providers: [{ id: 'mock', name: 'mock', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'test' }],
    members: [
      { id: 'mA', name: 'A', providerId: 'mock', model: 'mock-ok', persona: '你是分析者', temp: 0.6, color: '#5b8def', enabled: true },
      { id: 'mB', name: 'B', providerId: 'mock', model: 'mock-ok', persona: '你是评审者', temp: 0.7, color: '#e06c5b', enabled: true }
    ],
    settings: { mode: 'manual', rounds: 1 }
  });
  const cfg = await bridge.getConfig();
  return JSON.stringify({ providers: cfg.providers.map(p => p.name + ':' + p.hasKey), members: cfg.members.length });
})()
"""))

    print("\n[2] 拉取模型列表（跨域直连 mock）")
    print(ev("bridge.listModels('mock').then(r => 'OK ' + r.join(',')).catch(e => 'FAIL: ' + e.message)"))

    print("\n[3] 重新加载页面，读回配置")
    ws.send(json.dumps({"id": 7777, "method": "Page.reload", "params": {}}))
    time.sleep(4)
    print("  供应商:", ev("state.providers.map(p => p.name + ' hasKey=' + p.hasKey).join(',')"))
    print("  成员:", ev("state.members.map(m => m.name + '@' + m.model).join(', ')"))

    print("\n[4] 发一条消息，验证流式输出")
    ev("document.querySelector('#input').value = 'hello 测试'; send(); 'ok'")
    for _ in range(40):
        if ev("state.running") is False:
            break
        time.sleep(0.5)
    print("  消息数:", ev("state.messages.length"))
    print("  回复:", ev("(state.messages.at(-1).text||'').slice(0,60)"))
    print("  usage:", ev("JSON.stringify(state.messages.at(-1).usage || null)"))

    print("\n[5] 会话持久化")
    print("  会话列表:", ev("state.sessions.map(s => s.title + ':' + (s.messageCount||0)).join(' | ')"))
    ws.send(json.dumps({"id": 7778, "method": "Page.reload", "params": {}}))
    time.sleep(4)
    print("  重载后会话:", ev("state.sessions.map(s => s.title + ':' + (s.messageCount||0)).join(' | ')"))
    print("  重载后消息数:", ev("state.messages.length"))

    print("\n控制台错误:", errors[:5] or "无")
    ws.close()
finally:
    proc.terminate()
