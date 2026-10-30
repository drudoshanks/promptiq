"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

interface SocialButtonsProps {
  providers: Array<"google" | "github">;
  callbackURL: string;
}

const LABELS = { google: "Continue with Google", github: "Continue with GitHub" } as const;

export function SocialButtons({ providers, callbackURL }: SocialButtonsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (providers.length === 0) return null;

  return (
    <div className="space-y-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          className="w-full"
          loading={busy === provider}
          onClick={async () => {
            setBusy(provider);
            setError(null);
            const result = await authClient.signIn.social({ provider, callbackURL });
            if (result.error) {
              setError(result.error.message ?? "Sign-in failed. Please try again.");
              setBusy(null);
            }
          }}
        >
          {LABELS[provider]}
        </Button>
      ))}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex items-center gap-3 py-2 text-sm text-ink-faint" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
