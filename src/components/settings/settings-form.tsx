"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Switch } from "@/components/ui/field";
import { authClient } from "@/lib/auth/client";
import { api, ApiError, downloadFromApi, errorMessage } from "@/lib/client/api";

interface SettingsFormProps {
  initial: {
    email: string | null;
    displayName: string | null;
    historyEnabled: boolean;
    personalisationEnabled: boolean;
    sessionIsFresh: boolean;
  };
}

/** Settings/privacy screen (§11): separate toggles, data export, account deletion. */
export function SettingsForm({ initial }: SettingsFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [history, setHistory] = useState(initial.historyEnabled);
  const [personalisation, setPersonalisation] = useState(initial.personalisationEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<{ message: string; reauth: boolean } | null>(null);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api("/api/v1/me/preferences-settings", {
        method: "PATCH",
        body: { history_enabled: history, personalisation_enabled: personalisation, display_name: displayName.trim() || null },
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function exportData() {
    setExporting(true);
    setError(null);
    try {
      await downloadFromApi("/api/v1/exports", { method: "POST" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api("/api/v1/account/deletion", { method: "POST", body: { confirm_email: confirmEmail } });
      await authClient.signOut();
      router.push("/?deleted=1");
      router.refresh();
    } catch (err) {
      setDeleteError({ message: errorMessage(err), reauth: err instanceof ApiError && err.code === "REAUTH_REQUIRED" });
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="panel space-y-6 p-5 sm:p-6">
        <h2 className="text-base">Profile</h2>
        <Field label="Display name">{(p) => <Input id={p.id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />}</Field>
        <p className="text-sm text-ink-soft">Signed in as {initial.email ?? "an account without an email"}.</p>
      </section>

      <section className="panel space-y-6 p-5 sm:p-6">
        <h2 className="text-base">Privacy</h2>
        <Switch
          checked={history}
          onChange={setHistory}
          label="Keep a history of my prompts"
          description="When on, each optimisation (original and proposal) is saved to your library. When off, nothing is stored unless you save it yourself. Existing saved prompts are not affected."
        />
        <Switch
          checked={personalisation}
          onChange={setPersonalisation}
          label="Apply my saved preferences"
          description="When off, rewrites ignore your preference memory. The preferences themselves stay where they are until you delete them."
        />
        <p className="text-sm text-ink-soft">
          Prompts you optimise are sent to OpenAI&apos;s API from our servers to be rewritten. We do not use your prompts for analytics, and we do not train models on them.
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved ? <Alert tone="success">Settings saved.</Alert> : null}
        <Button variant="primary" loading={saving} onClick={save}>
          Save settings
        </Button>
      </section>

      <section className="panel space-y-4 p-5 sm:p-6">
        <h2 className="text-base">Your data</h2>
        <p className="text-[0.9375rem] text-ink-soft">Download everything you own as one JSON file: settings, preferences, every prompt with all its versions, and your feedback.</p>
        <Button loading={exporting} onClick={exportData}>
          Export my data
        </Button>
      </section>

      <section className="panel space-y-4 border-danger/40 p-5 sm:p-6">
        <h2 className="text-base">Delete account</h2>
        <p className="text-[0.9375rem] text-ink-soft">
          Deletes your prompts, versions, preferences, feedback and sign-in immediately. Anonymised usage records are kept for billing and abuse prevention. Copies in encrypted backups expire within 30 days.
        </p>
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Delete my account
        </Button>
      </section>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Delete your account?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Keep my account
            </Button>
            <Button variant="danger" loading={deleting} disabled={!confirmEmail.trim()} onClick={deleteAccount}>
              Delete everything
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p>This cannot be undone. Export your data first if you want to keep it.</p>
          {!initial.sessionIsFresh ? (
            <Alert tone="warning">You signed in a while ago. For safety, sign out and sign in again before deleting your account.</Alert>
          ) : null}
          <Field label="Type your email to confirm">{(p) => <Input id={p.id} type="email" autoComplete="off" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} />}</Field>
          {deleteError ? (
            <Alert tone="error">
              {deleteError.message}
              {deleteError.reauth ? (
                <div className="mt-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      await authClient.signOut();
                      router.push("/sign-in?next=/app/settings");
                    }}
                  >
                    Sign out now
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
