// Environment defaults for tests. No real services are contacted: the
// optimiser runs in mock mode and the database is an embedded PGlite instance.
(process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
process.env.APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.OPTIMISER_PROVIDER ??= "mock";
process.env.LOG_LEVEL ??= "error";
process.env.GLOBAL_DAILY_SPEND_CAP_USD ??= "0";
process.env.ADMIN_EMAILS ??= "ops@example.com";
