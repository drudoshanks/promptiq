import { sql } from "drizzle-orm";

import type { Db, Tx } from "./types";

/**
 * Run `fn` inside a transaction whose row-level-security context is the given
 * application user (db/migrations/0002_row_level_security.sql). Application code
 * still filters every query by user ID; this is the second lock on the door.
 */
export async function withUserScope<T>(
  db: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL cannot take a bind parameter; the value is a validated UUID.
    assertUuid(userId);
    await tx.execute(sql.raw(`SET LOCAL app.user_id = '${userId}'`));
    return fn(tx);
  });
}

/** System scope for auth bootstrap, billing webhooks, admin aggregates, deletion. */
export async function withSystemScope<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.role = 'system'`));
    return fn(tx);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error("Invalid identifier");
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
