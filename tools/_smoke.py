import json,subprocess,sys,time,urllib.request
sys.stdout.reconfigure(encoding="utf-8",errors="replace")
EDGE=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
P=9339
import tempfile
prof=tempfile.mkdtemp(prefix="edgeclean")
proc=subprocess.Popen([EDGE,f"--remote-debugging-port={P}",f"--user-data-dir={prof}","--no-first-run","--no-default-browser-check","http://127.0.0.1:8788/"])
time.sleep(7)
try:
    import websocket
    page=next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{P}/json/list")) if t["type"]=="page" and "8788" in t["url"])
    ws=websocket.create_connection(page["webSocketDebuggerUrl"],timeout=60,suppress_origin=True)
    seq=0; errs=[]
    ws.send(json.dumps({"id":1,"method":"Runtime.enable","params":{}}))
    time.sleep(0.3)
    def ev(e,w=40000):
        global seq; seq+=1; mid=2000+seq
        ws.send(json.dumps({"id":mid,"method":"Runtime.evaluate","params":{"expression":e,"returnByValue":True,"awaitPromise":True}}))
        end=time.time()+w/1000
        while time.time()<end:
            m=json.loads(ws.recv())
            if m.get("method")=="Runtime.exceptionThrown":
                d=m["params"]["exceptionDetails"]; errs.append(str((d.get("exception") or {}).get("description",d.get("text")))[:200])
            if m.get("id")==mid:
                r=m.get("result",{})
                if "exceptionDetails" in r: return "EXC:"+str(r["exceptionDetails"])[:300]
                return r.get("result",{}).get("value")
        return "TIMEOUT"
    print("标题:", ev("document.title"))
    print("bridge 方法数:", ev("Object.keys(window.api).length"))
    print("首次进入自动建会话:", ev("state.sessions.length"), "| 成员:", ev("state.members.length"))
    print("配置 mock 后拉模型:", ev("""
(async () => {
  await bridge.saveConfig({ providers: [{ id:'mock', name:'mock', baseUrl:'http://127.0.0.1:8799/v1', apiKey:'t' }] });
  const cfg = await bridge.getConfig();
  state.providers = cfg.providers;
  return await bridge.listModels('mock').then(r => 'OK ' + r.length + ' 个').catch(e => 'FAIL ' + e.message);
})()
"""))
    print("PDF 库可用:", ev("import('./vendor/pdf.min.mjs').then(m => typeof m.getDocument === 'function' ? 'yes' : 'no').catch(e => 'ERR ' + e.message)"))
    print("Mammoth 可用:", ev("typeof window.mammoth"))
    print("异常:", errs[:3] or "无")
    ws.close()
finally:
    proc.terminate()
