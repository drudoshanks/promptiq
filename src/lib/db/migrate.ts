/**
 * Minimal, transparent SQL migration runner (SRS §16.2: backward-compatible,
 * reviewable migrations). Applies db/migrations/*.sql in filename order and
 * records each applied file in schema_migrations. Used by scripts/migrate.ts
 * (node-postgres) and by the test suite (embedded PGlite).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SqlExecutor {
  /** Execute one or more SQL statements with no parameters. */
  exec(sql: string): Promise<unknown>;
  /** Query rows with no parameters. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

export async function runMigrations(
  executor: SqlExecutor,
  options: { dir?: string; log?: (msg: string) => void } = {},
): Promise<{ applied: string[]; skipped: string[] }> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);

  await executor.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const appliedRows = await executor.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const alreadyApplied = new Set(appliedRows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of await listMigrationFiles(dir)) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    log(`applying ${file}`);
    await executor.exec("BEGIN");
    try {
      await executor.exec(sql);
      await executor.exec(
        `INSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`,
      );
      await executor.exec("COMMIT");
    } catch (error) {
      await executor.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
    applied.push(file);
  }

  return { applied, skipped };
}
