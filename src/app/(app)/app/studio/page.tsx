import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PromptStudio } from "@/components/studio/prompt-studio";
import { getCurrentUser } from "@/lib/auth/session";
import { isTaskCategory, type TaskCategory } from "@/lib/categories";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { listModelOptions } from "@/lib/services/estimates";
import { listEnabledPreferences } from "@/lib/services/preferences";
import { getPrompt } from "@/lib/services/prompts";

export const metadata: Metadata = { title: "Prompt studio" };

interface StudioSearchParams {
  prompt?: string;
  version?: string;
}

export default async function StudioPage({ searchParams }: { searchParams: Promise<StudioSearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const params = await searchParams;
  const plan = planFor(user.planCode);

  // Re-optimise an existing version from the library (owner-scoped lookup).
  let initialText = "";
  let initialCategory: TaskCategory | "auto" = "auto";
  if (params.prompt && isUuid(params.prompt)) {
    try {
      const prompt = await getPrompt(db, user.id, params.prompt);
      const version = params.version && isUuid(params.version) ? prompt.versions.find((v) => v.id === params.version) : prompt.versions[prompt.versions.length - 1];
      if (version) {
        initialText = version.promptText;
        if (isTaskCategory(prompt.category)) initialCategory = prompt.category;
      }
    } catch {
      // Not found or not owned: open an empty studio rather than leaking anything.
    }
  }

  const [preferences, models] = await Promise.all([
    user.personalisationEnabled ? listEnabledPreferences(db, user.id) : Promise.resolve([]),
    listModelOptions(db),
  ]);

  return (
    <PromptStudio
      initialText={initialText}
      initialCategory={initialCategory}
      maxPromptChars={plan.maxPromptChars}
      historyEnabled={user.historyEnabled}
      personalisationEnabled={user.personalisationEnabled}
      savedPreferenceCount={preferences.length}
      models={models}
      defaultModel={DEFAULT_TARGET_MODEL}
    />
  );
}
