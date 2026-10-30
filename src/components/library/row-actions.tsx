"use client";

import { Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/client/api";

interface RowActionsProps {
  id: string;
  title: string;
  isFavourite: boolean;
  archived: boolean;
}

/** Quick actions for one library row (§4). Destructive actions are confirmed. */
export function RowActions({ id, title, isFavourite, archived }: RowActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-pressed={isFavourite}
        aria-label={isFavourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`}
        disabled={busy !== null}
        onClick={() => run("fav", () => api(`/api/v1/prompts/${id}`, { method: "PATCH", body: { is_favourite: !isFavourite } }))}
      >
        <Star className="h-4 w-4" aria-hidden="true" fill={isFavourite ? "currentColor" : "none"} />
      </button>
      <Link href={`/app/library/${id}`} className="btn btn-ghost btn-sm">
        Open
      </Link>
      <Link href={`/app/library/${id}#suggestions`} className="btn btn-ghost btn-sm">
        Analyse
      </Link>
      <Link href={`/app/library/${id}#optimise`} className="btn btn-ghost btn-sm">
        Optimise
      </Link>
      <Link href={`/app/library/${id}#versions`} className="btn btn-ghost btn-sm">
        Compare
      </Link>
      <Button size="sm" variant="ghost" loading={busy === "dup"} disabled={busy !== null} onClick={() => run("dup", () => api(`/api/v1/prompts/${id}/duplicate`, { method: "POST" }))}>
        Duplicate
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy === "arch"}
        disabled={busy !== null}
        onClick={() => run("arch", () => api(`/api/v1/prompts/${id}/archive`, { method: "PATCH", body: { archived: !archived } }))}
      >
        {archived ? "Unarchive" : "Archive"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
        Delete
      </Button>
      {error ? (
        <Alert tone="error" className="w-full">
          {error}
        </Alert>
      ) : null}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this prompt?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy === "del"}
              onClick={() =>
                run("del", async () => {
                  await api(`/api/v1/prompts/${id}`, { method: "DELETE" });
                  setConfirmDelete(false);
                })
              }
            >
              Delete prompt
            </Button>
          </>
        }
      >
        <p>
          &ldquo;{title}&rdquo; and all its versions, analyses and suggestions will be deleted. Archive it instead if you might want it later.
        </p>
      </Dialog>
    </div>
  );
}
