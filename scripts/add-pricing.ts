/**
 * Record a verified pricing snapshot (docs/token-cost-estimation.md).
 *
 *   npm run pricing:add -- --model gpt-5.4-mini --input 0.75 --cached 0.075 --output 4.5 \
 *     --source https://developers.openai.com/api/docs/models/gpt-5.4-mini \
 *     [--provider openai] [--effective-from 2026-11-01] [--version openai:gpt-5.4-mini:2026-11-01]
 *
 * The model's current open-ended record (if any) is closed at --effective-from,
 * so historical estimates stay reproducible with the price they were made with.
 * Only enter rates you have checked against the provider's own pricing page.
 */
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { isSupportedModel } from "../src/lib/config/models";
import * as schema from "../src/lib/db/schema";
import type { Db } from "../src/lib/db/types";
import { addPricing } from "../src/lib/services/pricing";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requiredNumber(name: string): number {
  const value = Number(arg(name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number (USD per 1M tokens)`);
  return value;
}

async function main() {
  const model = arg("model");
  const source = arg("source");
  if (!model || !source) throw new Error("--model and --source are required");
  if (!isSupportedModel(model)) throw new Error(`"${model}" is not in the supported model registry (src/lib/config/models.ts)`);
  const effectiveFrom = new Date(arg("effective-from") ?? new Date().toISOString().slice(0, 10));
  const cached = arg("cached");
  const provider = arg("provider") ?? "openai";

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const db = drizzle(pool, { schema }) as unknown as Db;
    const row = await addPricing(
      db,
      {
        provider,
        modelId: model,
        pricingVersion: arg("version") ?? `${provider}:${model}:${effectiveFrom.toISOString().slice(0, 10)}`,
        inputPerMillion: requiredNumber("input"),
        cachedInputPerMillion: cached === undefined ? null : Number(cached),
        outputPerMillion: requiredNumber("output"),
        effectiveFrom,
        source,
        verifiedAt: new Date(),
      },
      { closePrevious: true },
    );
    console.log(`added ${row.pricingVersion} (effective ${row.effectiveFrom.toISOString()})`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
