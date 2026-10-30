import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInForm } from "@/components/auth/sign-in-form";
import { Alert } from "@/components/ui/alert";
import { enabledProviders, safeNext } from "@/lib/auth/providers";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="space-y-4">
      {params.reset ? <Alert tone="success">Your password was changed. Sign in with the new one.</Alert> : null}
      <SignInForm providers={enabledProviders()} next={next} />
    </div>
  );
}
