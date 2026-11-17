/**
 * Apply pending SQL migrations to DATABASE_URL.
 *   npm run db:migrate
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { runMigrations } from "../src/lib/db/migrate";
import * as schema from "../src/lib/db/schema";
import { syncPromptLibrary, type LibrarySeedItem } from "../src/lib/services/prompt-library";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const result = await runMigrations(
      {
        exec: (sql) => client.query(sql),
        query: async (sql) => (await client.query(sql)).rows,
      },
      { log: (m) => console.log(m) },
    );
    console.log(
      `migrations: ${result.applied.length} applied, ${result.skipped.length} already applied`,
    );
    // Keep the Prompt library catalogue in sync with the committed seed file.
    const seed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../db/seed/prompt-library.json"), "utf8")) as LibrarySeedItem[];
    const library = await syncPromptLibrary(drizzle(client, { schema }) as never, seed);
    console.log(`prompt library: ${library.inserted} added, ${library.updated} updated, ${library.hidden} hidden, ${library.unchanged} unchanged`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
