# Deployment Guide

## Runtime

- Node.js 22 is required for production parity with the VPS.
- Install dependencies with `npm ci`.
- Copy `.env.example` to `.env` and fill the real secrets locally on the target machine. Do not copy `.env` between machines through source archives or chat.

## Environment

Use `.env.example` as the complete checklist. Important production entries:

- `DATABASE_URL`: SQLite example is `file:/opt/weimo/prisma/dev.db`; keep it on persistent disk.
- `STORAGE_ROOT`: optional external storage root. If omitted, files live in `/opt/weimo/storage`.
- `PUBLIC_BASE_URL`: public HTTP/HTTPS base used for signed file links.
- `SESSION_SECRET`, `FILE_ACCESS_SECRET`, `WEBHOOK_SECRET`: set strong unique values.
- `ILINK_API_KEY`, `ILINK_BASE_URL`, `ILINK_CDN_BASE`: iLink API and CDN configuration.
- `LLM_*`, `OPENAI_*`, `IMAGE_RECOGNITION_*`, `DASHSCOPE_*`, `TAVILY_API_KEY`: AI provider configuration.

## Fresh Deploy

```bash
cd /opt/weimo
npm ci
npx prisma db push
npx prisma generate
npm run build
systemctl restart weimo
curl -fsS http://<your-server-ip>:3000/health
```

## Data Migration

- Migrate SQLite by copying the database file referenced by `DATABASE_URL`.
- Migrate files by copying `storage/` or the directory named by `STORAGE_ROOT`.
- Keep database and storage from the same snapshot so report/media paths remain valid.
- Never overwrite production `.env`, `storage/`, database files, or `node_modules` from a source upload.

## systemd Example

```ini
[Unit]
Description=weimo
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/weimo
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node dist/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Rollback

Before upload, back up remote source files with a timestamped suffix or archive. To roll back, restore the previous source/dist snapshot, keep the existing production `.env` and storage/database, then restart `weimo` and verify `/health`.
