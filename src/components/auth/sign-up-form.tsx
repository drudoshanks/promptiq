"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { authClient } from "@/lib/auth/client";

import { SocialButtons } from "./social-buttons";

interface SignUpFormProps {
  providers: Array<"google" | "github">;
}

export function SignUpForm({ providers }: SignUpFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Use a password of at least 10 characters.");
      return;
    }
    setBusy(true);
    const result = await authClient.signUp.email({ name: name.trim() || email.split("@")[0] || "there", email: email.trim(), password, callbackURL: "/app/onboarding" });
    if (result.error) {
      setError(result.error.message ?? "Could not create your account. Please try again.");
      setBusy(false);
      return;
    }
    router.push("/app/onboarding");
    router.refresh();
  }

  return (
    <div className="panel p-6 sm:p-8">
      <h1 className="text-2xl">Create your account</h1>
      <p className="mt-2 text-ink-soft">Free plan, no card needed. You can change every setting later.</p>
      <div className="mt-6">
        <SocialButtons providers={providers} callbackURL="/app/onboarding" />
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Name">
          {(p) => <Input id={p.id} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
        <Field label="Email">
          {(p) => <Input id={p.id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
        <Field label="Password" help="At least 10 characters.">
          {(p) => <Input id={p.id} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
        <p className="text-sm text-ink-soft">
          By continuing you agree to the <Link href="/#privacy">privacy notice</Link>. Prompts you optimise are sent to OpenAI&apos;s API from our servers.
        </p>
      </form>
      <p className="mt-5 text-sm text-ink-soft">
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  );
}
