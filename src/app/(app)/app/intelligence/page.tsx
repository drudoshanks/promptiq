import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { IntelligenceWorkspace } from "@/components/intelligence/workspace";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { listModelOptions } from "@/lib/services/estimates";
import { getStoredAnalysisView } from "@/lib/services/intelligence";
import { getPromptPreferences } from "@/lib/services/prompt-preferences";
import { getPrompt } from "@/lib/services/prompts";

export const metadata: Metadata = { title: "Prompt intelligence" };

export default async function IntelligencePage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/app/intelligence");
  const { prompt: promptId } = await searchParams;
  const [models, prefs] = await Promise.all([listModelOptions(db), getPromptPreferences(db, user.id)]);

  let prompt = null;
  let initialAnalysis = null;
  let defaultModel = prefs.preferredModel ?? DEFAULT_TARGET_MODEL;
  if (promptId && isUuid(promptId)) {
    try {
      const p = await getPrompt(db, user.id, promptId);
      const current = p.versions[p.versions.length - 1];
      if (current) {
        prompt = { id: p.id, title: p.title, versionId: current.id, versionNumber: current.versionNumber, text: current.promptText };
        defaultModel = p.targetModel ?? defaultModel;
        initialAnalysis = await getStoredAnalysisView(db, user.id, p.id, defaultModel);
      }
    } catch {
      prompt = null; // not found or not owned: start with an empty workspace
    }
  }

  return (
    <IntelligenceWorkspace
      key={prompt?.versionId ?? "new"}
      models={models.map((m) => ({ id: m.id, label: m.label }))}
      defaultModel={defaultModel}
      defaultMode={prefs.defaultOptimisationMode}
      prompt={prompt}
      initialAnalysis={initialAnalysis}
    />
  );
}
