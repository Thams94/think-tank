"""修：OCR 兼容流式响应；搜索改用 Bing RSS 源（结果更干净）。"""

import io

p = r"D:\Harness\ai-group-chat-web\web-bridge.js"
s = io.open(p, encoding="utf-8").read()

# ---------- 1) OCR 容错：JSON 或 SSE 都能解析 ----------
old_ocr = """    if (!res.ok) throw new Error('OCR HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
    const json = await res.json();
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }"""
new_ocr = """    if (!res.ok) throw new Error('OCR HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));

    const raw = await res.text();
    const trimmed = raw.trim();

    // 有些服务商无视 stream:false，仍然流式返回，这里都兼容
    if (trimmed.startsWith('data:')) {
      let text = '';
      for (const line of trimmed.split('\\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) text += d.content;
        } catch { /* 忽略 */ }
      }
      return text;
    }

    const json = JSON.parse(trimmed);
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  }"""
assert old_ocr in s
s = s.replace(old_ocr, new_ocr, 1)

# ---------- 2) 搜索：优先 Bing RSS，其次原链接解析 ----------
old_search = """    let results = [];
    const errors = [];

    try {
      const md = await jina('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN');
      results = parseLinks(md);
      if (!results.length) errors.push('bing: 无结果');
    } catch (e) {
      errors.push('bing: ' + String(e.message || e).slice(0, 80));
    }

    if (!results.length) {
      try {
        const md = await jina('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
        results = parseLinks(md);
        if (!results.length) errors.push('ddg: 无结果');
      } catch (e) {
        errors.push('ddg: ' + String(e.message || e).slice(0, 80));
      }
    }"""

new_search = """    let results = [];
    const errors = [];

    // 1) Bing RSS：结构干净，标题/摘要/链接都有
    try {
      const xml = await jina('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q));
      results = parseRss(xml);
      if (!results.length) errors.push('bing-rss: 无结果');
    } catch (e) {
      errors.push('bing-rss: ' + String(e.message || e).slice(0, 80));
    }

    // 2) 退化为普通搜索结果页链接解析
    if (!results.length) {
      try {
        const md = await jina('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN');
        results = parseLinks(md);
        if (!results.length) errors.push('bing: 无结果');
      } catch (e) {
        errors.push('bing: ' + String(e.message || e).slice(0, 80));
      }
    }

    // 3) 再退化为 DuckDuckGo
    if (!results.length) {
      try {
        const md = await jina('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
        results = parseLinks(md);
        if (!results.length) errors.push('ddg: 无结果');
      } catch (e) {
        errors.push('ddg: ' + String(e.message || e).slice(0, 80));
      }
    }"""
assert old_search in s
s = s.replace(old_search, new_search, 1)

# ---------- 3) RSS 解析函数 ----------
old_links = """  function parseLinks(markdown) {"""
new_links = """  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function parseRss(xml) {
    const out = [];
    const re = /<item>([\\s\\S]*?)<\\/item>/g;
    let m;
    while ((m = re.exec(xml)) && out.length < 10) {
      const body = m[1];
      const title = decodeXml((body.match(/<title>([\\s\\S]*?)<\\/title>/) || [])[1] || '');
      const link = decodeXml((body.match(/<link>([\\s\\S]*?)<\\/link>/) || [])[1] || '');
      const desc = decodeXml((body.match(/<description>([\\s\\S]*?)<\\/description>/) || [])[1] || '');
      if (!/^https?:\\/\\//i.test(link)) continue;
      if (!title) continue;
      out.push({ title, url: link, snippet: desc.slice(0, 300) });
    }
    return out;
  }

  function parseLinks(markdown) {"""
assert old_links in s
s = s.replace(old_links, new_links, 1)

# ---------- 4) 链接解析：过滤明显不是结果项的链接 ----------
old_filter = """      const url = m[2];
      if (/bing\\.com|microsoft\\.com|msn\\.com|go\\.microsoft/i.test(url)) continue;
      if (seen.has(url)) continue;"""
new_filter = """      const url = m[2];
      if (/bing\\.com|microsoft\\.com|msn\\.com|go\\.microsoft|w3\\.org/i.test(url)) continue;
      if (/许可证|备案|隐私|条款|关于我们|京ICP|沪ICP/i.test(m[1])) continue;
      if (seen.has(url)) continue;"""
assert old_filter in s
s = s.replace(old_filter, new_filter, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("已修复 OCR 兼容与搜索源")
