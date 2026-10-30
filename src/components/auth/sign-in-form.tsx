"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { authClient } from "@/lib/auth/client";

import { SocialButtons } from "./social-buttons";

interface SignInFormProps {
  providers: Array<"google" | "github">;
  next: string;
}

export function SignInForm({ providers, next }: SignInFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setError(result.error.status === 401 || result.error.status === 403 ? "That email and password combination was not recognised." : (result.error.message ?? "Sign-in failed. Please try again."));
      setBusy(false);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <div className="panel p-6 sm:p-8">
      <h1 className="text-2xl">Sign in</h1>
      <p className="mt-2 text-ink-soft">Welcome back. Your prompts and preferences are where you left them.</p>
      <div className="mt-6">
        <SocialButtons providers={providers} callbackURL={next} />
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email">
          {(p) => <Input id={p.id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
        <Field label="Password">
          {(p) => <Input id={p.id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
      <div className="mt-5 flex flex-wrap justify-between gap-2 text-sm text-ink-soft">
        <Link href="/forgot-password">Forgot your password?</Link>
        <span>
          New here? <Link href="/sign-up">Create an account</Link>
        </span>
      </div>
    </div>
  );
}
