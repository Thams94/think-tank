"""搜索解析：适配 jina 输出的 Markdown 结构。"""

import io

p = r"D:\Harness\ai-group-chat-web\web-bridge.js"
s = io.open(p, encoding="utf-8").read()

# 1) 新增 markdown 解析器（替换 parseRss 的调用方式）
old = """  function parseLinks(markdown) {"""
new = """  /** 解析 jina 输出的 Markdown：`### [标题](链接)` + 下一段作为摘要 */
  function parseJinaMarkdown(md) {
    const lines = String(md).split('\\n');
    const out = [];
    const seen = new Set();

    for (let i = 0; i < lines.length && out.length < 10; i++) {
      const line = lines[i].trim();
      const m = line.match(/^#{2,4}\\s*\\[([^\\]]{2,150})\\]\\((https?:\\/\\/[^)\\s]+)\\)/);
      if (!m) continue;

      const title = m[1].trim();
      const url = m[2];
      if (/bing\\.com|microsoft\\.com|msn\\.com|w3\\.org/i.test(url)) continue;
      if (seen.has(url)) continue;

      let snippet = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (/^#{1,6}\\s/.test(t)) break;
        if (/^\\[[^\\]]*\\]\\([^)]*\\)$/.test(t)) break;
        snippet = t;
        break;
      }

      seen.add(url);
      out.push({ title, url, snippet: snippet.slice(0, 300) });
    }
    return out;
  }

  function parseLinks(markdown) {"""
assert old in s
s = s.replace(old, new, 1)

# 2) 搜索流程：RSS 页面 → jina markdown 解析
old2 = """    // 1) Bing RSS：结构干净，标题/摘要/链接都有
    try {
      const xml = await jina('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q));
      results = parseRss(xml);
      if (!results.length) errors.push('bing-rss: 无结果');
    } catch (e) {
      errors.push('bing-rss: ' + String(e.message || e).slice(0, 80));
    }"""
new2 = """    // 1) Bing RSS（jina 会转成 Markdown）：标题/摘要/链接都有，最干净
    try {
      const md = await jina('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q));
      results = parseJinaMarkdown(md);
      if (!results.length) results = parseRss(md);
      if (!results.length) errors.push('bing-rss: 无结果');
    } catch (e) {
      errors.push('bing-rss: ' + String(e.message || e).slice(0, 80));
    }"""
assert old2 in s
s = s.replace(old2, new2, 1)

# 3) 普通搜索页也走 markdown 解析
old3 = """        const md = await jina('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN');
        results = parseLinks(md);"""
new3 = """        const md = await jina('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN');
        results = parseJinaMarkdown(md);
        if (!results.length) results = parseLinks(md);"""
assert old3 in s
s = s.replace(old3, new3, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("搜索解析已改为 Markdown 结构")
