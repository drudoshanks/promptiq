import { z } from "zod";

import { created, withApi } from "@/lib/api/handler";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { restoreVersion, serialiseVersion } from "@/lib/services/prompts";

const paramsSchema = z.object({ id: z.uuid(), versionId: z.uuid() });

/** POST /api/v1/prompts/{id}/restore/{versionId} — new version copied from an earlier one. */
export const POST = withApi<"required", { id: string; versionId: string }>({ auth: "required", rateLimit: "userPerMinute" }, async ({ user, params }) => {
  const { id, versionId } = paramsSchema.parse(params);
  return created(serialiseVersion(await restoreVersion(db, user.id, planFor(user.planCode), id, versionId)));
});
