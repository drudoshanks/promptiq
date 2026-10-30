import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Driver-agnostic database handle.
 *
 * Production uses node-postgres; tests use an embedded PGlite instance. Both are
 * `PgDatabase` subtypes, so every service function accepts this type and can be
 * exercised against a real PostgreSQL engine without a server.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Tx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Either a database handle or an open transaction. */
export type DbOrTx = Db | Tx;
