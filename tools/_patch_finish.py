"""网页版收尾：隐藏代理字段、加图标、加页面脚注。"""

import io

p = r"D:\Harness\ai-group-chat-web\index.html"
s = io.open(p, encoding="utf-8").read()

# 1) favicon（内联 SVG，避免 404）
if "rel=\"icon\"" not in s:
    s = s.replace(
        '  <title>AI 群聊 · 网页版</title>',
        '  <link rel="icon" href="data:image/svg+xml,'
        '%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 100 100%27%3E'
        '%3Crect width=%27100%27 height=%27100%27 rx=%2722%27 fill=%27%235b8def%27/%3E'
        '%3Ctext x=%2750%27 y=%2768%27 font-size=%2758%27 text-anchor=%27middle%27 fill=%27white%27%3E群%3C/text%3E'
        '%3C/svg%3E">\n  <title>AI 群聊 · 网页版</title>',
        1,
    )

# 2) 网页版不需要"代理"字段（浏览器自带代理），隐藏但保留元素
if "hide-in-web" not in s:
    s = s.replace(
        """      <label>代理（留空 = 使用系统代理）""",
        """      <label class="hide-in-web">代理（留空 = 使用系统代理）""",
        1,
    )

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("index.html 收尾完成")

# 3) CSS 隐藏
p2 = r"D:\Harness\ai-group-chat-web\style.css"
c = io.open(p2, encoding="utf-8").read()
if ".hide-in-web" not in c:
    c += "\n.hide-in-web { display: none !important; }\n"
    io.open(p2, "w", encoding="utf-8", newline="\n").write(c)
    print("style.css 已加隐藏规则")
