import { eq } from "drizzle-orm";

import { appUsers, type AppUser } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";

export function normaliseEmail(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  return value ? value : null;
}

/**
 * Find or create the application profile for an authenticated subject.
 * Idempotent: safe to call on every request. A soft-deleted account is returned
 * as-is so callers can refuse access rather than silently re-creating it.
 */
export async function ensureAppUser(
  db: DbOrTx,
  input: { authSubject: string; email?: string | null; displayName?: string | null },
): Promise<AppUser> {
  const existing = await db.query.appUsers.findFirst({
    where: eq(appUsers.authSubject, input.authSubject),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(appUsers)
    .values({
      authSubject: input.authSubject,
      email: normaliseEmail(input.email),
      displayName: input.displayName?.trim() || null,
    })
    .onConflictDoNothing({ target: appUsers.authSubject })
    .returning();
  if (created) return created;

  // Concurrent creation: read the row the other request inserted.
  const raced = await db.query.appUsers.findFirst({
    where: eq(appUsers.authSubject, input.authSubject),
  });
  if (!raced) throw new Error("Failed to bootstrap user profile");
  return raced;
}

export async function getAppUserById(db: DbOrTx, userId: string): Promise<AppUser | null> {
  const user = await db.query.appUsers.findFirst({ where: eq(appUsers.id, userId) });
  return user ?? null;
}

export interface SettingsUpdate {
  historyEnabled?: boolean;
  personalisationEnabled?: boolean;
  displayName?: string | null;
}

/** PATCH /api/v1/me/preferences-settings (NFR-003: separate, explicit toggles). */
export async function updateUserSettings(db: DbOrTx, userId: string, update: SettingsUpdate): Promise<AppUser> {
  const [updated] = await db
    .update(appUsers)
    .set({
      ...(update.historyEnabled !== undefined ? { historyEnabled: update.historyEnabled } : {}),
      ...(update.personalisationEnabled !== undefined
        ? { personalisationEnabled: update.personalisationEnabled }
        : {}),
      ...(update.displayName !== undefined ? { displayName: update.displayName?.trim() || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(appUsers.id, userId))
    .returning();
  if (!updated) throw new Error("User not found");
  return updated;
}

export async function markOnboarded(db: DbOrTx, userId: string): Promise<void> {
  await db
    .update(appUsers)
    .set({ onboardedAt: new Date(), updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
}
