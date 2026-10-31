import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PreferencesManager } from "@/components/preferences/preferences-manager";
import { PromptPreferencesForm } from "@/components/preferences/prompt-preferences-form";
import { SUGGESTION_CATEGORY_LABELS, type SuggestionCategory } from "@/lib/analysis/schema";
import { selectableModels } from "@/lib/config/models";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { getFeedbackHistory, getPromptPreferences, serialisePromptPreferences } from "@/lib/services/prompt-preferences";
import { listPreferences, serialisePreference } from "@/lib/services/preferences";

export const metadata: Metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const [items, promptPrefs, feedback] = await Promise.all([listPreferences(db, user.id), getPromptPreferences(db, user.id), getFeedbackHistory(db, user.id)]);
  return (
    <div className="space-y-6">
      <div>
        <h1>Preference memory</h1>
        <p className="mt-2 text-ink-soft">
          Everything PromptIQ remembers about how you like prompts written. Each entry shows where it came from, and deleting one takes effect on your next optimisation.
        </p>
      </div>
      <section aria-labelledby="prompt-prefs-heading" className="panel p-5">
        <h2 id="prompt-prefs-heading" className="text-lg">
          Prompt preferences
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Used to tailor suggestions and optimisation of your saved prompts. Nothing here is inferred from your prompts.</p>
        <div className="mt-4">
          <PromptPreferencesForm
            initial={serialisePromptPreferences(promptPrefs)}
            models={selectableModels().map((m) => ({ id: m.id, label: m.label }))}
            feedbackHistory={Object.entries(feedback).map(([category, c]) => ({ category, label: SUGGESTION_CATEGORY_LABELS[category as SuggestionCategory] ?? category, ...c }))}
          />
        </div>
      </section>

      <h2 className="text-lg">Rewrite preferences</h2>
      <PreferencesManager initial={items.map(serialisePreference)} personalisationEnabled={user.personalisationEnabled} />
    </div>
  );
}
