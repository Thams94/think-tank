"""给 getKbContext 传入 OCR 用的视觉模型（网页版用它做图片转写）。"""

import io
import os

paths = [
    r"D:\Harness\ai-group-chat-web\app.js",
    r"D:\Harness\ai-group-chat\renderer\app.js",
]

old = """  try {
    const ctx = await bridge.kbContext({
      files: state.kb.files,
      budget: Number(state.kb.budget) || 12000,
      wantImages,
    });"""

new = """  try {
    // 非视觉成员：挑一个「支持看图」的成员用它的模型做图片转写
    const ocrMember = state.members.find((m) => m.supportsImages && m.model && providerOf(m));
    const ocr = ocrMember ? { providerId: ocrMember.providerId, model: ocrMember.model } : null;

    const ctx = await bridge.kbContext({
      files: state.kb.files,
      budget: Number(state.kb.budget) || 12000,
      wantImages,
      ocr,
    });"""

for p in paths:
    if not os.path.exists(p):
        print("跳过（不存在）:", p)
        continue
    s = io.open(p, encoding="utf-8").read()
    if "wantImages," in s and "ocrMember" in s:
        print("已存在，跳过:", p)
        continue
    assert old in s, "未找到目标片段: " + p
    io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new, 1))
    print("已修改:", p)
