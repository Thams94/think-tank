"""给 mock 服务加 CORS 支持，便于浏览器直连测试。"""

import io

p = r"D:\Harness\ai-group-chat\tools\mock-openai.js"
s = io.open(p, encoding="utf-8").read()

old = """const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {"""

new = """const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Max-Age': '600',
};

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {"""

assert old in s, "未找到 mock 服务入口"
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new, 1))
print("mock 已支持 CORS")
