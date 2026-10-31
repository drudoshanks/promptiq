import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PromptDetail } from "@/components/library/prompt-detail";
import { IntelligenceWorkspace } from "@/components/intelligence/workspace";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { listModelOptions } from "@/lib/services/estimates";
import { getStoredAnalysisView } from "@/lib/services/intelligence";
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

  const [models, prefs] = await Promise.all([listModelOptions(db), getPromptPreferences(db, user.id)]);
  const current = prompt.versions[prompt.versions.length - 1];
  if (!current) notFound();
  const targetModel = prompt.targetModel ?? prefs.preferredModel ?? DEFAULT_TARGET_MODEL;
  const initialAnalysis = await getStoredAnalysisView(db, user.id, prompt.id, targetModel);

  return (
    <PromptDetail
      key={`${current.id}:${prompt.updatedAt.getTime()}`}
      prompt={{ ...serialisePrompt(prompt), versions: prompt.versions.map(serialiseVersion) }}
      maxVersions={planFor(user.planCode).maxVersionsPerPrompt}
      defaultModel={targetModel}
      models={models.map((m) => ({ id: m.id, label: m.label }))}
      workspace={
        <IntelligenceWorkspace
          key={current.id}
          embedded
          models={models.map((m) => ({ id: m.id, label: m.label }))}
          defaultModel={targetModel}
          defaultMode={prefs.defaultOptimisationMode}
          prompt={{ id: prompt.id, title: prompt.title, versionId: current.id, versionNumber: current.versionNumber, text: current.promptText }}
          initialAnalysis={initialAnalysis}
        />
      }
    />
  );
}
