"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/client/api";

type Status = "pending" | "accepted" | "dismissed" | "deferred";

/** Accept / later / dismiss buttons for one suggestion in the cross-library list. */
export function SuggestionActions({ id, status, title }: { id: string; status: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: Status) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/suggestions/${id}`, { method: "PATCH", body: { status: next } });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Decide on "${title}"`}>
      <Button size="sm" variant={status === "accepted" ? "primary" : "secondary"} disabled={busy} onClick={() => set(status === "accepted" ? "pending" : "accepted")}>
        {status === "accepted" ? "Accepted" : "Accept"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(status === "deferred" ? "pending" : "deferred")}>
        {status === "deferred" ? "Undo later" : "Later"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => set("dismissed")}>
        Dismiss
      </Button>
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}
