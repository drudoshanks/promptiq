/**
 * Apply pending SQL migrations to DATABASE_URL.
 *   npm run db:migrate
 */
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

import { runMigrations } from "../src/lib/db/migrate";

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
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
