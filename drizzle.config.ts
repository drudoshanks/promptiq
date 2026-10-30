import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for `npm run db:generate` / `db:studio`.
 * The hand-written SQL in db/migrations is the source of truth; use `generate`
 * to draft a migration from schema changes, then review and move it there.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./db/drizzle-drafts",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://promptiq:promptiq@localhost:5432/promptiq" },
  strict: true,
  verbose: true,
});
