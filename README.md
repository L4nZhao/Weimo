<div align="center">

<img src="public/weimo-wordmark.svg" width="400" alt="Weimo" />

**A personal AI assistant living in WeChat — remembers, retrieves, and gets things done for you.**

[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.)

**English** · [简体中文](README.zh-CN.md)

</div>

---

## What can Weimo do?

| Capability | Just say (in WeChat) |
|---|---|
| 📦 Media archive & semantic search | "find the Oriental Pearl photo" → retrieves anything you ever sent |
| 💬 Archive Q&A (RAG) | "how long is the warranty in that file I sent?" → answers from content |
| 📄 Work reports → Word | send a progress update → get a formatted .docx back in chat |
| ⏰ Reminders & schedule | "remind me at 3pm tomorrow" → proactive push |
| ✅ Todo list | "add a todo: book flights" / "what's on my list" |
| 🌐 Web search | "search today's news" |
| 🌍 Translation | "translate to English: 辛苦了" |
| 🧭 Self-describing | "what can you do" → lists every loaded skill |

Plus an **admin console** (`/login`): files, skills, templates and WeChat binding, with light/dark themes and mobile layout.

## Architecture

```
WeChat ⇄ iLink protocol (polling + encrypted media)
            │
   message assembly & guards → two-tier intent routing (regex fast paths + LLM classifier)
            │
   agent loop (function calling) ⇄ skill system (directory auto-scan)
            │
Express + Prisma/SQLite + local storage ── scheduler (proactive reminders)
```

## Quick Start

> Prerequisite: Node.js ≥ 22

```bash
git clone <your-repo-url> weimo && cd weimo
npm install
cp .env.example .env      # ① configure your LLM (next section)
npx prisma db push        # ② init database (SQLite, zero deps)
npm run dev               # ③ open http://localhost:3000/login
```

Default admin login is `admin` / `admin123` — **change it in `.env` immediately**.

## Bring your own LLM (required)

Weimo ships with no model. Any **OpenAI-compatible** API works. Minimal config — just 4 variables:

```ini
# Chat & routing (any OpenAI-compatible provider)
LLM_API_KEY=sk-xxxx
LLM_BASE_URL=https://api.your-provider.com/v1
LLM_MODEL=gpt-4o-mini

# Embeddings for semantic search (Alibaba DashScope)
DASHSCOPE_API_KEY=sk-xxxx
```

Optional enhancements (features degrade gracefully when unset):

| Variable | Enables |
|---|---|
| `IMAGE_RECOGNITION_API_KEY/BASE_URL/MODEL` | image understanding (defaults to your LLM config; needs a vision model) |
| `TAVILY_API_KEY` | web-search skill ([tavily.com](https://tavily.com) free tier works) |
| `ASR_BASE_URL` / `ASR_API_KEY` | voice messages as commands (Whisper-compatible endpoint) |
| `ROUTER_MODEL` | a smaller/cheaper model for intent routing |

## Connect WeChat

1. Fill the `ILINK_*` variables in `.env` with credentials from your WeChat iLink provider.
2. Open the admin console → WeChat page → scan the QR code to bind your bot.
3. Chat away — every message is archived and every skill becomes available.

## Add a new skill

Skills are directories — drop two files under `src/skills/<your-skill>/` and they load automatically:

```
src/skills/weather-query/
├── SKILL.md      # description (frontmatter: name + description)
└── handler.ts    # exports `tools` (function-calling schemas) and `execute`
```

Optionally add a high-confidence regex fast path in `src/services/plannerService.ts`; anything unregistered is classified by the LLM router.

## Deployment

Single-host systemd deployment and migration guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Security notes

- `.env`, `storage/` and the SQLite database are git-ignored — **never commit them**.
- In production: change the admin password, set strong `SESSION_SECRET` / `FILE_ACCESS_SECRET`, enable `REQUIRE_WEBHOOK_SIGNATURE`, put HTTPS in front.

## Tests

```bash
npm test   # tsc build + 41 integration tests (fully mocked, no real API keys needed)
```

## License

[MIT](LICENSE)
