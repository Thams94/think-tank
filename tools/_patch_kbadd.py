"""桥接层：抽出 registerFiles，并暴露 kbAddFiles（便于拖拽/测试）。"""

import io

p = r"D:\Harness\ai-group-chat-web\web-bridge.js"
s = io.open(p, encoding="utf-8").read()

old = """  function kbPick() {
    return new Promise((resolve) => {"""

new = """  /** 把 File 列表登记进来，返回虚拟路径数组 */
  function registerFiles(files) {
    const paths = [];
    for (const f of files || []) {
      const id = `file:${f.name}:${f.size}:${f.lastModified || 0}`;
      fileMap.set(id, f);
      paths.push(id);
    }
    return paths;
  }

  function kbPick() {
    return new Promise((resolve) => {"""

assert old in s
s = s.replace(old, new, 1)

old2 = """      input.onchange = () => {
        const paths = [];
        for (const f of input.files) {
          const id = `file:${f.name}:${f.size}:${f.lastModified || 0}`;
          fileMap.set(id, f);
          paths.push(id);
        }
        finish(paths);
      };"""
new2 = """      input.onchange = () => finish(registerFiles(Array.from(input.files)));"""
assert old2 in s
s = s.replace(old2, new2, 1)

old3 = """    kbPick, kbIndex, kbContext,"""
new3 = """    kbPick, kbIndex, kbContext,
    kbAddFiles: async (files) => registerFiles(files),"""
assert old3 in s
s = s.replace(old3, new3, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("已加入 kbAddFiles")
