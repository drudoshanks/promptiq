import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SettingsForm } from "@/components/settings/settings-form";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1>Settings and privacy</h1>
        <p className="mt-2 text-ink-soft">History and personalisation are separate choices. Change either at any time.</p>
      </div>
      <SettingsForm
        initial={{
          email: user.email,
          displayName: user.displayName,
          historyEnabled: user.historyEnabled,
          personalisationEnabled: user.personalisationEnabled,
          sessionIsFresh: user.session.isFresh,
        }}
      />
    </div>
  );
}
