import type { CurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import type { RequestLogger } from "@/lib/logger";
import { getOptimiserProvider } from "@/lib/providers";
import type { IntelligenceContext } from "@/lib/services/intelligence";

export function intelligenceContext(user: CurrentUser, requestId: string, log: RequestLogger): IntelligenceContext {
  return { db, user, provider: getOptimiserProvider(), requestId, log, globalDailySpendCapUsd: env.GLOBAL_DAILY_SPEND_CAP_USD };
}

/** Request body source → service source. */
export function sourceOf(body: { prompt_text?: string | null; prompt_id?: string | null; version_id?: string | null }) {
  return body.prompt_id ? { promptId: body.prompt_id, versionId: body.version_id ?? null, text: body.prompt_text ?? null } : { text: body.prompt_text ?? "" };
}
