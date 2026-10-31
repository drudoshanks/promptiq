import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { IntelligenceWorkspace } from "@/components/intelligence/workspace";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { listModelOptions } from "@/lib/services/estimates";
import { getStoredAnalysisView } from "@/lib/services/intelligence";
import { listEnabledPreferences } from "@/lib/services/preferences";
import { getPromptPreferences } from "@/lib/services/prompt-preferences";
import { getPrompt } from "@/lib/services/prompts";

export const metadata: Metadata = { title: "Studio" };

/**
 * The single prompt workspace: write, analyse, optimise (any mode), check
 * requirements, compare tokens and cost, then save or export. Combines the
 * former Quick studio and Prompt intelligence pages.
 */
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ prompt?: string; version?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/app/studio");
  const params = await searchParams;
  const [models, prefs, saved] = await Promise.all([
    listModelOptions(db),
    getPromptPreferences(db, user.id),
    user.personalisationEnabled ? listEnabledPreferences(db, user.id) : Promise.resolve([]),
  ]);

  let prompt = null;
  let initialAnalysis = null;
  let defaultModel = prefs.preferredModel ?? DEFAULT_TARGET_MODEL;
  if (params.prompt && isUuid(params.prompt)) {
    try {
      const p = await getPrompt(db, user.id, params.prompt);
      const version = params.version && isUuid(params.version) ? p.versions.find((v) => v.id === params.version) : p.versions[p.versions.length - 1];
      if (version) {
        prompt = { id: p.id, title: p.title, versionId: version.id, versionNumber: version.versionNumber, text: version.promptText };
        defaultModel = p.targetModel ?? defaultModel;
        if (version.id === p.currentVersionId) initialAnalysis = await getStoredAnalysisView(db, user.id, p.id, defaultModel);
      }
    } catch {
      prompt = null; // not found or not owned: open an empty studio rather than leaking anything
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
      studio={{
        historyEnabled: user.historyEnabled,
        personalisationEnabled: user.personalisationEnabled,
        savedPreferenceCount: saved.length,
        maxPromptChars: planFor(user.planCode).maxPromptChars,
        modelOptions: models,
      }}
    />
  );
}
