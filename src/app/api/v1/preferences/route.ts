import { created, ok, parseJson, withApi } from "@/lib/api/handler";
import { createPreferenceSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { listPreferences, serialisePreference, upsertPreference } from "@/lib/services/preferences";

/** GET /api/v1/preferences — the caller's preference memory with provenance (FR-010). */
export const GET = withApi({ auth: "required" }, async ({ user }) => {
  const items = await listPreferences(db, user.id);
  return ok({ items: items.map(serialisePreference) });
});

/** POST /api/v1/preferences — create explicitly (§10.4). Source is always user_entered here. */
export const POST = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, createPreferenceSchema);
  const { preference, created: isNew } = await upsertPreference(db, user.id, {
    category: body.category,
    preferenceKey: body.preference_key,
    preferenceValue: body.preference_value,
    source: "user_entered",
  });
  return isNew ? created(serialisePreference(preference)) : ok(serialisePreference(preference));
});
