# Weimo contributor guide

Weimo is a WeChat assistant with media retrieval, report generation, reminders, and a web administration console. Start with the [README](../README.md) for setup and supported integrations.

## Source layout

| Path | Responsibility |
|---|---|
| `src/` | TypeScript server, routes, services, and the agent loop |
| `src/skills/` | Product skills discovered from their descriptions and handlers |
| `prisma/` | Database schema and setup tools |
| `public/` | Administration interface and static assets |
| `tests/` | Node integration checks |
| `scripts/` | Maintenance utilities |

## Local development

Use Node.js 22 or newer. From the repository root:

```sh
npm install
cp .env.example .env
npx prisma db push
npm run dev
```

Configure the local database, model access, and administration credentials before using the service. Open `http://localhost:3000/login`. WeChat binding and optional providers require their own configuration; use an isolated development account for integration work.

## Validation

- TypeScript and build changes: `npm run build`.
- Application behavior: `npm test`, which builds TypeScript and runs `tests/*.mjs`.
- Schema changes: review `prisma/schema.prisma`, the existing data, and migration impact before applying a database command.

Record the checks actually run. Automated checks do not establish that a live WeChat account or external provider works.

## Architecture constraints

- A product skill lives under `src/skills/<name>/` with `SKILL.md` and `handler.ts`; preserve discovery and tool execution conventions.
- Routing uses regex fast paths and an LLM classifier. Keep routing and the exposed tool descriptions consistent when adding a skill.
- Preserve authentication and file-access controls across the administration UI, message ingress, storage, and retrieval.

## Contributions

Keep each PR focused and describe its behavior changes and validation. Conventional commit types such as `feat`, `fix`, and `docs` are suitable.

Keep credentials, real chat records, uploaded files, local storage, and databases outside source control. Use synthetic or explicitly anonymized examples and fixtures.
