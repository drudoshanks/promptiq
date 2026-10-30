import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { runMigrations } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ensureAppUser } from "@/lib/services/users";

export interface TestDb {
  db: Db;
  client: PGlite;
  close: () => Promise<void>;
}

/**
 * Embedded PostgreSQL (PGlite) with the real SQL migrations applied — the
 * database tests run against the same schema production uses.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await runMigrations({
    exec: (sql) => client.exec(sql),
    query: async <T,>(sql: string) => (await client.query(sql)).rows as T[],
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, client, close: () => client.close() };
}

export async function createUser(db: Db, label: string, overrides: Partial<schema.AppUser> = {}) {
  const user = await ensureAppUser(db, { authSubject: `auth:${label}`, email: `${label}@example.com`, displayName: label });
  if (Object.keys(overrides).length === 0) return user;
  const { eq } = await import("drizzle-orm");
  const [updated] = await db.update(schema.appUsers).set(overrides).where(eq(schema.appUsers.id, user.id)).returning();
  return updated ?? user;
}
