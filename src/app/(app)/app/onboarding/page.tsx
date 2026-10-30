import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Welcome" };

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return <OnboardingForm initial={{ historyEnabled: user.historyEnabled, personalisationEnabled: user.personalisationEnabled }} />;
}
