# AI Group Chat · Multi-Model Discussion

Put **several LLMs into one conversation** so they can discuss, debate, and cross-check each other — instead of asking one model at a time.

English | [简体中文](README.md)

![Screenshot](web/docs/screenshot.png)

---

## Why

Asking one model gives you one answer with no way to tell whether it is wrong.
This tool lets you put models from different vendors in the same "group chat" so they can:

- **Challenge each other** — one proposes, another hunts for flaws
- **Split the work** — different models own different parts
- **Cross-check** — see several lines of reasoning on the same question

## Two builds

| Build | Location | Highlights |
|---|---|---|
| **Web** (recommended) | [`web/`](web/) | Pure static, no install, works on desktop and mobile, data stays in your browser |
| **Desktop** | [`desktop/`](desktop/) | Windows app (Electron): local folders, native OCR, DPAPI-encrypted keys |

> Live demo: https://thams94.github.io/ai-group-chat/

## Features

| Feature | Web | Desktop |
|---|:---:|:---:|
| Multiple providers (own URL + key each) | ✅ | ✅ |
| Personas / temperature / reasoning effort / max tokens per member | ✅ | ✅ |
| **Private @** (only you and the mentioned model can see it) | ✅ | ✅ |
| Three schedulers: manual @ / round-robin / moderator | ✅ | ✅ |
| Streaming output + reasoning trace | ✅ | ✅ |
| Multiple sessions, three-column layout, collapsible sidebars | ✅ | ✅ |
| Stop / continue / regenerate / edit messages | ✅ | ✅ |
| Local knowledge base (PDF / Word / TXT) | ✅ multi-file | ✅ |
| Knowledge-base images | ✅ vision model or transcription | ✅ vision model or native OCR |
| Web search | ✅ | ✅ |
| Export as Markdown | ✅ | ✅ |
| Encrypted key storage | ⚠️ local only | ✅ DPAPI |

## Quick start

### Web

```bash
cd web
node server.js 8788
# open http://127.0.0.1:8788/
```

On Windows just double-click `web/启动网页版.cmd`.

### Desktop (Windows)

```bash
cd desktop
npm install
npm start
```

Or download the installer from [Releases](https://github.com/Thams94/ai-group-chat/releases).

### Configure

1. **⚙ Settings** → **+ Add provider**
2. Enter the API base URL (OpenAI-compatible, e.g. `https://api.example.com/v1`) and key
3. Click **Fetch models** → Save
4. Click a member → pick a model, write a persona
5. Type `@name your question`

## Input syntax

| Syntax | Effect |
|---|---|
| `@name text` | Public mention |
| `@@name text` | **Private mention** — only you and that model can see it |

Keyboard: **Enter** sends, **Shift+Enter** inserts a newline.

## Docs

- [Deployment guide](web/部署说明.md) — Nginx, MIME types, CORS, optional proxy
- [Developer guide](web/开发说明.md) — architecture, bridge API, extension points
- [Desktop notes](desktop/README.md)

## Privacy

- Requests go **directly** from your client to the API endpoint you configured — no third-party server
- The code contains **no analytics, no telemetry, no upload logic**
- Keys stay on your machine; avoid public computers

## Known limitations

- Web: knowledge base stores extracted text only; image OCR needs a vision-capable member; search relies on `r.jina.ai` (free tier ≈ 20 req/min, shared)
- Desktop: Windows only; build needs Node 18+

## License

[AGPL-3.0](LICENSE)

> Free to use, modify and distribute. If you run a modified version as a network service,
> you must release your source under AGPL-3.0 as well.
