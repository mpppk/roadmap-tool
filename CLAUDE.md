# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Development Commands

```sh
bun dev              # start dev server with HMR
bun run typecheck    # TypeScript type check (no emit)
bun run lint         # Biome lint src/
bun run check        # Biome lint + format check
bun run format       # Biome format src/ (writes)
bun test             # run all tests
bun test src/db/schema.test.ts  # run a single test file
bun run build        # production build via build.ts
```

Database management (uses Drizzle Kit):

```sh
bun run db:generate  # generate migration from schema changes
bun run db:migrate   # apply pending migrations
bun run db:push      # push schema directly (dev only)
bun run db:studio    # open Drizzle Studio UI
```

CI runs: `typecheck` → `lint` → `format:check` → `build`. All must pass before merging.

## Architecture

This is a **team resource allocation / roadmap planning tool**. Users create features (work items), team members, and quarters, then allocate monthly capacity (0–1) of each member's time to features. Quarter views aggregate the three monthly records in the quarter.

### Stack

- **Runtime**: Bun with `Bun.serve()` — no Express, no Vite
- **Frontend**: React 19 SPA, mounted from `src/index.html` → `src/frontend.tsx`
- **Styling**: Tailwind CSS 4 via `bun-plugin-tailwind`; UI components from shadcn/ui (`src/components/ui/`)
- **API layer**: [oRPC](https://orpc.unnoq.com/) for end-to-end type-safe RPC over HTTP (`/orpc/*`)
- **Database**: SQLite via `bun:sqlite` + Drizzle ORM; schema in `src/db/schema.ts`
- **Validation**: Zod 4

### Request Flow

```
Browser → React (src/App.tsx)
       → orpc client (src/orpc-client.ts) → POST /orpc/<procedure>
       → Bun.serve (src/index.ts) → RPCHandler
       → router procedure (src/router.ts) — Zod-validated input
       → Drizzle ORM → SQLite (local file)
```

All API procedures live in a single file: `src/router.ts`. Procedures are grouped under `features`, `members`, `quarters`, `allocations`, and `export`. The exported `AppRouter` type is imported by the client for full type inference.

### Database Schema

Five tables, all with integer PKs and cascade-on-delete foreign keys:

- `features` — work items (unique name)
- `members` — team members (unique name)
- `quarters` — quarter groups: `(year, quarter 1-4)` unique pair
- `months` — planning periods: `(year, month 1-12)` unique pair, linked to a quarter
- `feature_months` — total capacity (`totalCapacity`) budgeted for a feature in a month
- `member_month_allocations` — individual member's monthly capacity (`capacity`, 0–1) allocated to a feature in a month

**Capacity unit**: capacity is stored monthly (0 = idle, 1 = full). Quarter display aggregates the three months in the quarter.

**Key constraint**: a member's total `capacity` across all features in a single month cannot exceed `1.0`. This is enforced in the `allocations.*` procedures in `router.ts`, not at the DB level.

### Allocation Business Logic

`allocations.updateTotal` — when a feature-month's total capacity changes, existing member allocations are **proportionally redistributed** (scaled by `newTotal / oldTotal`), then each is individually capped at the member's remaining monthly capacity. Quarter edits split the requested total across the three months, preserving existing month ratios or evenly distributing empty quarters.

`allocations.updateMemberAllocation` — silently caps the requested value at `1.0 - usedElsewhere` for that member×month.

`allocations.moveQuarter` — merges all feature-month data (total + member allocations) from one quarter into another month-by-month, respecting member monthly caps.

### Path Alias

`@/*` resolves to `src/*` (configured in `tsconfig.json` and used throughout the codebase).

### CLI

`src/cli.ts` provides a thin oRPC client CLI for features and members. It connects to `ROADMAP_URL` (default `http://localhost:3000`) and requires the server to be running.

```sh
bun src/cli.ts features list
bun src/cli.ts members add "Alice"
```

### Testing

Tests use `bun:test`. The only test file is `src/db/schema.test.ts`, which spins up an in-memory SQLite database via Drizzle to verify schema constraints.

### Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

`src/index.html` is imported directly into `src/index.ts` as a route handler — Bun's bundler transpiles and bundles `src/frontend.tsx` and CSS automatically. HMR is enabled in development via `import.meta.hot`.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
