import { and, asc, eq } from "drizzle-orm";

import { AppError, notFound } from "@/lib/api/errors";
import type { PreferenceKey, TaskCategory } from "@/lib/categories";
import { userPreferences, type PreferenceSource, type UserPreference } from "@/lib/db/schema";
import type { DbOrTx } from "@/lib/db/types";
import { preferenceValueString } from "@/lib/optimiser/preferences";

export const MAX_PREFERENCES_PER_USER = 60;

export async function listPreferences(db: DbOrTx, userId: string): Promise<UserPreference[]> {
  return db.query.userPreferences.findMany({
    where: eq(userPreferences.userId, userId),
    orderBy: [asc(userPreferences.category), asc(userPreferences.preferenceKey)],
  });
}

export async function listEnabledPreferences(db: DbOrTx, userId: string): Promise<UserPreference[]> {
  return db.query.userPreferences.findMany({
    where: and(eq(userPreferences.userId, userId), eq(userPreferences.enabled, true)),
  });
}

export interface UpsertPreferenceInput {
  category: TaskCategory;
  preferenceKey: PreferenceKey;
  preferenceValue: Record<string, unknown>;
  /** Assigned server-side (§10.4): the client cannot claim a feedback source. */
  source: PreferenceSource;
  confidence?: number;
}

/**
 * Create or update a preference for (user, category, key). Values are normalised
 * to `{ value }` so the optimiser reads one shape.
 */
export async function upsertPreference(db: DbOrTx, userId: string, input: UpsertPreferenceInput): Promise<{ preference: UserPreference; created: boolean }> {
  const value = preferenceValueString(input.preferenceKey, input.preferenceValue);
  if (!value) {
    throw new AppError("VALIDATION_ERROR", "preference_value must contain a non-empty string value.");
  }

  const existing = await db.query.userPreferences.findFirst({
    where: and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.category, input.category),
      eq(userPreferences.preferenceKey, input.preferenceKey),
    ),
  });

  if (!existing) {
    const count = (await listPreferences(db, userId)).length;
    if (count >= MAX_PREFERENCES_PER_USER) {
      throw new AppError("VALIDATION_ERROR", `You can store up to ${MAX_PREFERENCES_PER_USER} preferences.`);
    }
    const [created] = await db
      .insert(userPreferences)
      .values({
        userId,
        category: input.category,
        preferenceKey: input.preferenceKey,
        preferenceValue: { value },
        source: input.source,
        confidence: (input.confidence ?? 1).toFixed(3),
        enabled: true,
      })
      .returning();
    if (!created) throw new Error("Failed to create preference");
    return { preference: created, created: true };
  }

  const [updated] = await db
    .update(userPreferences)
    .set({
      preferenceValue: { value },
      source: input.source,
      confidence: (input.confidence ?? 1).toFixed(3),
      enabled: true,
      updatedAt: new Date(),
    })
    .where(and(eq(userPreferences.id, existing.id), eq(userPreferences.userId, userId)))
    .returning();
  if (!updated) throw notFound("Preference");
  return { preference: updated, created: false };
}

export interface PatchPreferenceInput {
  preferenceValue?: Record<string, unknown>;
  enabled?: boolean;
  category?: TaskCategory;
}

export async function patchPreference(db: DbOrTx, userId: string, preferenceId: string, input: PatchPreferenceInput): Promise<UserPreference> {
  const existing = await db.query.userPreferences.findFirst({
    where: and(eq(userPreferences.id, preferenceId), eq(userPreferences.userId, userId)),
  });
  if (!existing) throw notFound("Preference");

  const set: Partial<typeof userPreferences.$inferInsert> = { updatedAt: new Date() };
  if (input.preferenceValue !== undefined) {
    const value = preferenceValueString(existing.preferenceKey, input.preferenceValue);
    if (!value) throw new AppError("VALIDATION_ERROR", "preference_value must contain a non-empty string value.");
    set.preferenceValue = { value };
    set.source = "user_entered";
  }
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.category !== undefined) set.category = input.category;

  const [updated] = await db
    .update(userPreferences)
    .set(set)
    .where(and(eq(userPreferences.id, preferenceId), eq(userPreferences.userId, userId)))
    .returning();
  if (!updated) throw notFound("Preference");
  return updated;
}

export async function deletePreference(db: DbOrTx, userId: string, preferenceId: string): Promise<void> {
  const deleted = await db
    .delete(userPreferences)
    .where(and(eq(userPreferences.id, preferenceId), eq(userPreferences.userId, userId)))
    .returning({ id: userPreferences.id });
  if (deleted.length === 0) throw notFound("Preference");
}

export function serialisePreference(p: UserPreference) {
  return {
    id: p.id,
    category: p.category,
    preference_key: p.preferenceKey,
    preference_value: p.preferenceValue,
    value: preferenceValueString(p.preferenceKey, p.preferenceValue) ?? "",
    source: p.source,
    confidence: Number(p.confidence),
    enabled: p.enabled,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export type SerialisedPreference = ReturnType<typeof serialisePreference>;
