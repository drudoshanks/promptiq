import { ok, withApi } from "@/lib/api/handler";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { db } from "@/lib/db/client";
import { listModelOptions } from "@/lib/services/estimates";

/** GET /api/v1/models — target models PromptIQ can count for, with current pricing (or null). */
export const GET = withApi({ auth: "required" }, async () => {
  return ok({ default_model: DEFAULT_TARGET_MODEL, items: await listModelOptions(db) });
});
