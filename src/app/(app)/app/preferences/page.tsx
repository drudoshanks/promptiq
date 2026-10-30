import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PreferencesManager } from "@/components/preferences/preferences-manager";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { listPreferences, serialisePreference } from "@/lib/services/preferences";

export const metadata: Metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const items = await listPreferences(db, user.id);
  return (
    <div className="space-y-6">
      <div>
        <h1>Preference memory</h1>
        <p className="mt-2 text-ink-soft">
          Everything PromptIQ remembers about how you like prompts written. Each entry shows where it came from, and deleting one takes effect on your next optimisation.
        </p>
      </div>
      <PreferencesManager initial={items.map(serialisePreference)} personalisationEnabled={user.personalisationEnabled} />
    </div>
  );
}
