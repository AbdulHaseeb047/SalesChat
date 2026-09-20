# Raunaq POS

Shop billing, inventory, udhaar, and platform admin. Two folders — not an npm workspace, not Docker, not a git repo until you initialize it.

```text
Raunaq-POS/
  frontend/    Next.js 15 (marketing + POS + admin)
  backend/     Express 4 + Prisma 6 + PostgreSQL
```

## Prerequisites

- Node.js 20+
- PostgreSQL 16+ (local). Create a database, for example `pos_dev`.

## Run locally (two terminals)

```bash
# terminal 1 — API  http://localhost:3001
cd backend
copy .env.example .env
# set DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET
npm install
npx prisma migrate deploy
npx prisma db seed
npm run dev

# terminal 2 — web  http://localhost:3003
cd frontend
copy .env.example .env.local
npm install
npm run dev
```

On macOS/Linux use `cp` instead of `copy`.

- Marketing: http://localhost:3003
- Shop login: http://localhost:3003/pos/login
- Platform admin: http://localhost:3003/admin (after Super Admin login)
- Health: http://localhost:3001/health

Dev API proxy: the frontend rewrites `/api/:path*` to `http://localhost:3001/:path*` (`NEXT_PUBLIC_API_URL=/api`). Express routes stay at the root (`POST /auth/login`, not `/api/auth/login`).

## Seed logins

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@nexmind.com` | `SuperAdmin123!` |
| Sales rep | `sales@nexmind.com` | `SalesRep123!` |
| Demo shop owner | `owner@demo.shop` | `DemoShop123!` |

Change these after first login in any environment that is not a throwaway machine.

## URLs

| Area | Paths |
|---|---|
| Public site | `/`, `/features`, `/pricing`, `/about`, `/contact` |
| Shop POS | `/pos/login`, `/pos`, `/pos/sale`, `/pos/sales`, `/pos/inventory`, … |
| Platform | `/admin`, `/admin/clients`, `/admin/sales-reps` |

Shop users are scoped by `tenantId` on the JWT. That id is never taken from the request body.

## Scripts

Frontend (`cd frontend`): `npm run dev`, `lint`, `typecheck`, `format`, `format:check`, `build`

Backend (`cd backend`): `npm run dev`, `typecheck`, `test`, `format`, `format:check`, `build`

## Production notes

- Frontend: set `NEXT_PUBLIC_API_URL` to the public backend origin (no `/api` suffix). Leave the `/api` rewrite for local dev.
- Backend: `CORS_ORIGINS` (comma-separated frontend origins), `TRUST_PROXY=true` behind Railway/nginx, JWT secrets ≥ 32 characters.
- Secrets stay in host env. Do not commit `.env`.

## Git

This folder is not initialized. When you are ready:

```bash
cd D:\Projects\Raunaq-POS
git init
```

CI lives in `.github/workflows/ci.yml` (format, lint, typecheck, frontend build, backend tests against Postgres).

## Docs

- [PROJECT.md](PROJECT.md) — architecture and port rules
- [PARITY.md](PARITY.md) — manual checklist vs the previous app
