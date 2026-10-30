import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PromptDetail } from "@/components/library/prompt-detail";
import { PromptWorkspace } from "@/components/library/prompt-workspace";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { getLatestAnalysis, serialiseAnalysis, serialiseSuggestion } from "@/lib/services/analysis";
import { listModelOptions } from "@/lib/services/estimates";
import { getPromptPreferences } from "@/lib/services/prompt-preferences";
import { getPrompt, serialisePrompt, serialiseVersion, type PromptWithVersions } from "@/lib/services/prompts";

export const metadata: Metadata = { title: "Prompt" };

export default async function PromptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  let prompt: PromptWithVersions;
  try {
    prompt = await getPrompt(db, user.id, id);
  } catch {
    notFound();
  }

  const [latest, models, prefs] = await Promise.all([getLatestAnalysis(db, user.id, prompt.id), listModelOptions(db), getPromptPreferences(db, user.id)]);
  const current = prompt.versions[prompt.versions.length - 1];
  if (!current) notFound();
  const analysedVersion = latest ? (prompt.versions.find((v) => v.id === latest.analysis.promptVersionId)?.versionNumber ?? null) : null;
  const targetModel = prompt.targetModel ?? prefs.preferredModel ?? DEFAULT_TARGET_MODEL;

  return (
    <PromptDetail
      key={`${current.id}:${prompt.updatedAt.getTime()}`}
      prompt={{ ...serialisePrompt(prompt), versions: prompt.versions.map(serialiseVersion) }}
      maxVersions={planFor(user.planCode).maxVersionsPerPrompt}
      defaultModel={targetModel}
      models={models.map((m) => ({ id: m.id, label: m.label }))}
      workspace={
        <PromptWorkspace
          key={current.id}
          promptId={prompt.id}
          currentVersion={{ id: current.id, number: current.versionNumber, text: current.promptText }}
          targetModel={targetModel}
          defaultMode={prefs.defaultOptimisationMode}
          models={models}
          initialAnalysis={latest ? serialiseAnalysis(latest.analysis) : null}
          initialSuggestions={latest ? latest.suggestions.map(serialiseSuggestion) : []}
          analysedVersionNumber={analysedVersion}
        />
      }
    />
  );
}
