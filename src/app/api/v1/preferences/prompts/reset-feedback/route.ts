import { ok, withApi } from "@/lib/api/handler";
import { db } from "@/lib/db/client";
import { resetFeedbackHistory } from "@/lib/services/prompt-preferences";

/** POST /api/v1/preferences/prompts/reset-feedback — stop dismissed suggestions from shaping future analyses. */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ user }) => ok({ reset: await resetFeedbackHistory(db, user.id) }));
