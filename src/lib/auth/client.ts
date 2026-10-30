"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client. Talks only to this app's /api/auth/* routes; no
 * provider secret ever reaches the browser (NFR-001).
 */
export const authClient = createAuthClient({});

export const { useSession } = authClient;
