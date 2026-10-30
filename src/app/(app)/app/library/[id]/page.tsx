import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PromptDetail } from "@/components/library/prompt-detail";
import { getCurrentUser } from "@/lib/auth/session";
import { DEFAULT_TARGET_MODEL } from "@/lib/config/models";
import { planFor } from "@/lib/config/plans";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/scope";
import { getPrompt, serialisePrompt, serialiseVersion } from "@/lib/services/prompts";

export const metadata: Metadata = { title: "Prompt" };

export default async function PromptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  let prompt;
  try {
    prompt = await getPrompt(db, user.id, id);
  } catch {
    notFound();
  }

  return (
    <PromptDetail
      prompt={{ ...serialisePrompt(prompt), versions: prompt.versions.map(serialiseVersion) }}
      maxVersions={planFor(user.planCode).maxVersionsPerPrompt}
      defaultModel={DEFAULT_TARGET_MODEL}
    />
  );
}
