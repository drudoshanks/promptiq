import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { db } from "@/lib/db/client";
import type { AppUser } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { enforceManualSubscriptionExpiry } from "@/lib/services/payments";
import { ensureAppUser } from "@/lib/services/users";

import { auth, FRESH_SESSION_MS } from "./auth";

export interface CurrentUser extends AppUser {
  /** Whether this account may use operator screens (FR-020). */
  isAdmin: boolean;
  session: {
    id: string;
    createdAt: Date;
    expiresAt: Date;
    /** True when the session was created recently enough for destructive actions. */
    isFresh: boolean;
  };
}

/**
 * Resolve the authenticated application user from request headers.
 * Returns null for anonymous requests and for accounts pending deletion.
 */
export async function getCurrentUserFromHeaders(requestHeaders: Headers): Promise<CurrentUser | null> {
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) return null;

  const appUser = await ensureAppUser(db, {
    authSubject: result.user.id,
    email: result.user.email,
    displayName: result.user.name,
  });
  if (appUser.deletedAt) return null;
  // Manually paid (UPI) subscriptions end on their period end: downgrade before
  // any entitlement check sees this request.
  if (appUser.planCode !== "free" && (await enforceManualSubscriptionExpiry(db, appUser.id))) appUser.planCode = "free";

  const createdAt = new Date(result.session.createdAt);
  return {
    ...appUser,
    isAdmin: env.ADMIN_EMAILS.includes((appUser.email ?? "").toLowerCase()),
    session: {
      id: result.session.id,
      createdAt,
      expiresAt: new Date(result.session.expiresAt),
      isFresh: Date.now() - createdAt.getTime() < FRESH_SESSION_MS,
    },
  };
}

/** Request-cached variant for server components and server actions. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  return getCurrentUserFromHeaders(await headers());
});
