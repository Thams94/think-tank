"""网页版 index.html：调整 CSP 与脚本加载。"""

import io

p = r"D:\Harness\ai-group-chat-web\index.html"
s = io.open(p, encoding="utf-8").read()

# 1) CSP：允许直连任意 API 域名、blob 图片、动态导入
old_csp = """  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;">"""
new_csp = """  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src *; worker-src 'self' blob:; script-src 'self' 'unsafe-inline';">"""
assert old_csp in s
s = s.replace(old_csp, new_csp, 1)

# 2) 脚本加载：vendor → web-bridge → app
old_script = """  <script src="app.js"></script>"""
new_script = """  <script src="vendor/mammoth.browser.min.js"></script>
  <script src="web-bridge.js"></script>
  <script src="app.js"></script>"""
assert old_script in s
s = s.replace(old_script, new_script, 1)

# 3) 标题标注网页版
s = s.replace("<title>AI 群聊</title>", "<title>AI 群聊 · 网页版</title>", 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("index.html 已适配网页版")
