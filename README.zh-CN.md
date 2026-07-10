<div align="center">

<img src="public/weimo-wordmark.svg" width="400" alt="Weimo" />

**微信里的个人 AI 助理 — 替你记住、找回并处理一切**

[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](.)

[English](README.md) · **简体中文**

</div>

---

## Weimo 能做什么

| 能力 | 在微信里说 |
|---|---|
| 📦 媒体归档与语义检索 | 「找一下东方明珠」→ 自动找回你发过的图片/文件 |
| 💬 档案问答（RAG） | 「我发过的保修文件保修多久」→ 直接回答内容 |
| 📄 项目汇报 → Word | 发一段工作汇报 → 生成 .docx 并微信直发 |
| ⏰ 提醒与日程 | 「明天下午3点提醒我开会」→ 到点主动推送 |
| ✅ 待办清单 | 「记个待办 买机票」「我有哪些待办」 |
| 🌐 联网搜索 | 「搜一下今天的新闻」 |
| 🌍 翻译 | 「翻译成英文：辛苦了」 |
| 🧭 能力自述 | 「你能干什么」→ 动态列出全部技能 |

配套**管理后台**（`/login`）：文件、技能、模板、微信绑定的可视化管理，亮/暗双主题，移动端适配。

## 架构一览

```
微信 ⇄ iLink 协议（轮询 + 媒体加解密）
          │
     消息装配与守卫 → 双层意图路由（正则快捷通道 + LLM 分类）
          │
     Agent 循环（Function Calling）⇄ 技能系统（目录自动扫描）
          │
Express + Prisma/SQLite + 本地存储 ── 定时调度器（提醒主动推送）
```

## 快速开始

> 前置：Node.js ≥ 22

```bash
git clone <your-repo-url> weimo && cd weimo
npm install
cp .env.example .env      # ① 按下节配置大模型
npx prisma db push        # ② 初始化数据库（SQLite，零依赖）
npm run dev               # ③ 启动，访问 http://localhost:3000/login
```

管理后台默认账号 `admin` / `admin123` —— **首次启动后请立即在 .env 中修改**。

## 配置大模型（必读）

Weimo 不内置任何模型，需自备 **OpenAI 兼容** 的 API。最小可运行配置只需 4 项：

```ini
# 对话与路由（任何 OpenAI 兼容服务商）
LLM_API_KEY=sk-xxxx
LLM_BASE_URL=https://api.your-provider.com/v1
LLM_MODEL=gpt-4o-mini

# 向量检索（阿里云百炼，用于媒体/记忆语义搜索）
DASHSCOPE_API_KEY=sk-xxxx
```

可选增强（不填则对应功能自动降级，不影响启动）：

| 变量 | 启用的功能 |
|---|---|
| `IMAGE_RECOGNITION_API_KEY/BASE_URL/MODEL` | 图片内容识别（默认复用 LLM 配置，模型需支持视觉） |
| `TAVILY_API_KEY` | 联网搜索技能（[tavily.com](https://tavily.com) 免费额度可用） |
| `ASR_BASE_URL` / `ASR_API_KEY` | 语音消息转写为指令（需支持 Whisper 接口的服务商） |
| `ROUTER_MODEL` | 意图路由使用独立的更小模型以降低成本 |

## 接入微信

1. 在 `.env` 填入 `ILINK_API_KEY`（微信 iLink 开放能力）。
2. 打开管理后台 → 「微信」页 → 生成二维码扫码绑定机器人。
3. 绑定后即可在微信中直接对话，所有消息自动归档、全部技能可用。

## 添加一个新技能

技能即目录——在 `src/skills/<your-skill>/` 放两个文件即可被自动加载：

```
src/skills/weather-query/
├── SKILL.md      # 技能说明（frontmatter: name + description）
└── handler.ts    # 导出 tools（Function Calling schema）与 execute
```

复杂技能可在 `src/services/plannerService.ts` 为其增加高置信路由快捷通道；未注册的意图会由 LLM 路由自动分类。

## 部署

单机 systemd 部署与跨设备迁移手册见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 安全须知

- `.env`、`storage/`、SQLite 数据库均已列入 `.gitignore`，**切勿提交**。
- 生产环境务必：修改管理员密码、设置强 `SESSION_SECRET`/`FILE_ACCESS_SECRET`、开启 `REQUIRE_WEBHOOK_SIGNATURE`、使用 HTTPS 反向代理。

## 测试

```bash
npm test   # tsc 构建 + 41 项集成测试（全部 mock，无需真实 API Key）
```

## License

[MIT](LICENSE)
