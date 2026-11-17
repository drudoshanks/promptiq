import type { CurrentUser } from "@/lib/auth/session";
import { planFor } from "@/lib/config/plans";
import { features } from "@/lib/env";

/** GET /api/v1/me payload. Never includes auth subjects or provider identifiers. */
export function serialiseMe(user: CurrentUser) {
  const plan = planFor(user.planCode);
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    plan: {
      code: plan.code,
      name: plan.name,
      unlimited: plan.unlimited,
      /** null means no limit (free mode). */
      optimisations_per_period: plan.unlimited ? null : plan.optimisationsPerPeriod,
      max_prompt_chars: plan.maxPromptChars,
      max_saved_prompts: plan.unlimited ? null : plan.maxSavedPrompts,
      max_versions_per_prompt: plan.unlimited ? null : plan.maxVersionsPerPrompt,
    },
    settings: {
      history_enabled: user.historyEnabled,
      personalisation_enabled: user.personalisationEnabled,
      onboarded: Boolean(user.onboardedAt),
    },
    session: {
      created_at: user.session.createdAt.toISOString(),
      expires_at: user.session.expiresAt.toISOString(),
      is_fresh: user.session.isFresh,
    },
    is_admin: user.isAdmin,
    features: { billing: features.billing },
    created_at: user.createdAt.toISOString(),
  };
}

export type Me = ReturnType<typeof serialiseMe>;
