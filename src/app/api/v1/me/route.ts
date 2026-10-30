import { ok, withApi } from "@/lib/api/handler";
import { serialiseMe } from "@/lib/api/serialisers";

/** GET /api/v1/me — profile, plan and settings. */
export const GET = withApi({ auth: "required" }, async ({ user }) => ok(serialiseMe(user)));
