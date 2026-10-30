import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PromptStudio } from "@/components/studio/prompt-studio";
import { getCurrentUser } from "@/lib/auth/session";
import { isTaskCategory, type TaskCategory } from "@/lib/categories";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
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

  const preferences = user.personalisationEnabled ? await listEnabledPreferences(db, user.id) : [];

  return (
    <PromptStudio
      initialText={initialText}
      initialCategory={initialCategory}
      maxPromptChars={plan.maxPromptChars}
      historyEnabled={user.historyEnabled}
      personalisationEnabled={user.personalisationEnabled}
      savedPreferenceCount={preferences.length}
    />
  );
}
