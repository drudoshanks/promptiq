"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { authClient } from "@/lib/auth/client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Could not send the reset email. Please try again.");
      return;
    }
    setDone(true);
  }

  return (
    <div className="panel p-6 sm:p-8">
      <h1 className="text-2xl">Reset your password</h1>
      {done ? (
        <Alert tone="success" className="mt-4" title="Check your email">
          If an account exists for {email.trim()}, a reset link is on its way. It expires in one hour.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <Field label="Email">{(p) => <Input id={p.id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-5 text-sm text-ink-soft">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </div>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password.length < 10) {
      setError("Use a password of at least 10 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "This reset link is invalid or has expired.");
      return;
    }
    router.push("/sign-in?reset=1");
  }

  return (
    <div className="panel p-6 sm:p-8">
      <h1 className="text-2xl">Choose a new password</h1>
      {!token ? (
        <Alert tone="error" className="mt-4">
          This reset link is missing its token. Request a new link from the sign-in page.
        </Alert>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <Field label="New password" help="At least 10 characters. Other sessions are signed out when you reset.">
            {(p) => <Input id={p.id} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={p.describedBy} />}
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Save new password
          </Button>
        </form>
      )}
    </div>
  );
}
