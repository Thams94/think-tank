"""重构成 web/ + desktop/ 双目录结构。"""

import io
import os
import shutil

REPO = r"D:\Harness\ai-group-chat-web"
DESK = r"D:\Harness\ai-group-chat"

# ---------- 1) 把网页版文件移进 web/ ----------
web_dir = os.path.join(REPO, "web")
os.makedirs(web_dir, exist_ok=True)

move_files = [
    "index.html", "style.css", "app.js", "web-bridge.js", "server.js",
    "robots.txt", "启动网页版.cmd",
    "使用说明.md", "部署说明.md", "开发说明.md",
]
move_dirs = ["vendor", "docs"]

for f in move_files:
    src = os.path.join(REPO, f)
    if os.path.exists(src):
        shutil.move(src, os.path.join(web_dir, f))
        print("移入 web/:", f)

for d in move_dirs:
    src = os.path.join(REPO, d)
    if os.path.exists(src):
        dst = os.path.join(web_dir, d)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.move(src, dst)
        print("移入 web/:", d)

# ---------- 2) 复制桌面版源码 ----------
desk_dir = os.path.join(REPO, "desktop")
os.makedirs(desk_dir, exist_ok=True)

desk_files = ["main.js", "preload.js", "package.json", "start.cmd", "README.md"]
for f in desk_files:
    src = os.path.join(DESK, f)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(desk_dir, f))
        print("复制 desktop/:", f)

for f in ["renderer"]:
    src = os.path.join(DESK, f)
    if os.path.exists(src):
        dst = os.path.join(desk_dir, f)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        print("复制 desktop/:", f)

# OCR 脚本（桌面版知识库需要）
os.makedirs(os.path.join(desk_dir, "tools"), exist_ok=True)
ocr = os.path.join(DESK, "tools", "ocr.ps1")
if os.path.exists(ocr):
    shutil.copy2(ocr, os.path.join(desk_dir, "tools", "ocr.ps1"))
    print("复制 desktop/tools/ocr.ps1")

# 图标
os.makedirs(os.path.join(desk_dir, "assets"), exist_ok=True)
for icon in ["icon.ico", "icon.png"]:
    src = os.path.join(DESK, "assets", icon)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(desk_dir, "assets", icon))
        print("复制 desktop/assets/:", icon)

print("\n完成")
for root, dirs, files in os.walk(REPO):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "tools", ".testfiles", ".edge-profile")]
    depth = root.replace(REPO, "").count(os.sep)
    if depth <= 1:
        print("  " * depth + os.path.basename(root) + "/")
        for f in files[:8]:
            print("  " * (depth + 1) + f)
