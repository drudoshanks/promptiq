import { noContent, ok, parseJson, withApi } from "@/lib/api/handler";
import { idParamSchema, patchPreferenceSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { deletePreference, patchPreference, serialisePreference } from "@/lib/services/preferences";

/** PATCH /api/v1/preferences/{id} — edit value, move category, enable/disable. */
export const PATCH = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const body = await parseJson(request, patchPreferenceSchema);
  const preference = await patchPreference(db, user.id, id, {
    preferenceValue: body.preference_value,
    enabled: body.enabled,
    category: body.category,
  });
  return ok(serialisePreference(preference));
});

/** DELETE /api/v1/preferences/{id} — delete; takes effect immediately (§11). */
export const DELETE = withApi<"required", { id: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id } = idParamSchema.parse(params);
  await deletePreference(db, user.id, id);
  return noContent();
});
