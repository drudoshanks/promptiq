# Deployment and operations (SRS §16)

## Environments

| Environment | Purpose | Controls |
| --- | --- | --- |
| Local | Developer work | `OPTIMISER_PROVIDER=mock`, `.env.local` (git-ignored), docker-compose PostgreSQL |
| Preview / staging | PR previews, integration tests | Separate database and API keys, synthetic data only, `GLOBAL_DAILY_SPEND_CAP_USD` low |
| Production | Real users and billing | Secrets in the platform's secret manager, restricted deploy access, backups, alerts |

## Build and run

The app builds to a standalone Next.js server (`output: "standalone"`):

```bash
npm ci
npm run build
node .next/standalone/server.js   # PORT defaults to 3000
```

A multi-stage `Dockerfile` is included. Any Node 22 host or platform that runs
Next.js 16 works (Vercel, Fly.io, Render, a container on your own VM).

## Database

- Managed PostgreSQL 14+ with automated backups and point-in-time recovery.
- Run `npm run db:migrate` before promoting a build. Migrations are plain SQL,
  applied in order and recorded in `schema_migrations`; write new ones so they
  are backward compatible with the previous application version (add columns
  before writing them; drop columns one release after you stop reading them).
- Row-level security (migration 0002) takes effect when the application connects
  as a role that does not own the tables. Recommended production setup:

  ```sql
  CREATE ROLE promptiq_app LOGIN PASSWORD '…';
  GRANT USAGE ON SCHEMA public TO promptiq_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO promptiq_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO promptiq_app;
  ```

  Run migrations as the owner role; run the app as `promptiq_app` and wrap
  user-scoped work with `withUserScope` / `withSystemScope` (`src/lib/db/scope.ts`)
  to set the per-transaction `app.user_id` / `app.role` settings. The MVP code
  path already filters every query by the authenticated user; RLS is the second
  lock.

## Secrets

`OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `AUTH_SECRET`,
OAuth client secrets and `RESEND_API_KEY` live only in the secret manager. None
are prefixed `NEXT_PUBLIC_`, so they cannot reach the browser bundle; `env.ts`
is `server-only`.

## Release pipeline

1. Pull request: lint, type check, unit + database tests, build, `npm audit`
   (`.github/workflows/ci.yml`). The `migrations` job applies the SQL to a real
   PostgreSQL 16 service; the `e2e` job runs the critical flows with the mock
   optimiser.
2. Build the artifact once; promote the same artifact from staging to production.
3. Take and verify a backup before any risky migration.
4. Deploy; check `GET /api/health`; run one mock or low-cost live optimisation.
5. Monitor for 30 minutes: error rate, p95 latency, provider failures, cost per
   run, quota errors, webhook processing (`/admin`).
6. Rollback: redeploy the previous artifact. Migrations must be backward
   compatible so the previous version keeps working against the new schema.

## Monitoring and alerts

Logs are JSON lines; ship them to your log platform and alert on:

- `request failed` with `code: INTERNAL_ERROR` above 1% of requests over 5 minutes
- `provider timeout` / `provider connection error` above 10 per minute
- `global daily spend cap reached` (any)
- `billing webhook processing failed` (any)
- `/api/health` returning 503

`/admin` shows p95 latency, failure rate, estimated spend and abuse signals.
For tracing, Next.js supports OpenTelemetry via `instrumentation.ts`; request IDs
are already attached to every log line and response header.

## Scaling notes (NFR-007)

The web tier is stateless except for two in-process caches: the rate limiter and
the idempotency replay cache. Both degrade gracefully with multiple instances
(limits become per-instance; replay falls back to the durable usage-event key,
which still prevents double billing). Move both to Redis before scaling past a
few instances.
