import { ok, parseJson, withApi } from "@/lib/api/handler";
import { serialiseMe } from "@/lib/api/serialisers";
import { settingsSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { markOnboarded, updateUserSettings } from "@/lib/services/users";

/** PATCH /api/v1/me/preferences-settings — history / personalisation toggles (NFR-003). */
export const PATCH = withApi({ auth: "required", rateLimit: "userPerMinute" }, async ({ request, user }) => {
  const body = await parseJson(request, settingsSchema);
  const updated = await updateUserSettings(db, user.id, {
    historyEnabled: body.history_enabled,
    personalisationEnabled: body.personalisation_enabled,
    displayName: body.display_name,
  });
  if (body.onboarded) await markOnboarded(db, user.id);
  return ok(
    serialiseMe({
      ...user,
      ...updated,
      onboardedAt: body.onboarded ? new Date() : updated.onboardedAt,
    }),
  );
});
