import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/lib/env";
import * as schema from "./schema";
import type { Db } from "./types";

declare global {
  // Reuse the pool across hot reloads in development.
  var __promptiqPool: Pool | undefined;
}

function createPool(): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
}

const pool = globalThis.__promptiqPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalThis.__promptiqPool = pool;
}

/** Application database handle (node-postgres). */
export const db: Db = drizzle(pool, { schema });

/** Raw pool for the migration runner and health checks. */
export { pool };
