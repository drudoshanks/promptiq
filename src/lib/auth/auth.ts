import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db/client";
import { authSchema } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email";
import { env, features } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ensureAppUser } from "@/lib/services/users";

/** Sessions younger than this count as "recent re-authentication" (SRS §12.2). */
export const FRESH_SESSION_MS = 15 * 60 * 1000;

/**
 * Better Auth instance (FR-001). This is the only file that knows which auth
 * library is in use; the rest of the application goes through
 * `getCurrentUser()` in ./session.ts.
 */
export const auth = betterAuth({
  appName: "PromptIQ",
  baseURL: env.APP_URL,
  secret: env.AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  advanced: {
    database: { generateId: () => crypto.randomUUID() },
    useSecureCookies: env.NODE_ENV === "production",
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 256,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your PromptIQ password",
        text: [
          `Hello ${user.name || ""}`.trim() + ",",
          "",
          "Someone requested a password reset for your PromptIQ account.",
          "If this was you, open the link below within one hour:",
          "",
          url,
          "",
          "If you did not request this, you can ignore this email.",
        ].join("\n"),
      });
    },
  },
  socialProviders: {
    ...(features.googleAuth
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {}),
    ...(features.githubAuth
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID as string,
            clientSecret: env.GITHUB_CLIENT_SECRET as string,
          },
        }
      : {}),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh expiry once a day of activity
    freshAge: FRESH_SESSION_MS / 1000,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await ensureAppUser(db, {
              authSubject: user.id,
              email: user.email,
              displayName: user.name,
            });
          } catch (error) {
            // getCurrentUser() bootstraps lazily as a fallback.
            logger.error("app user bootstrap failed", { message: (error as Error).message });
          }
        },
      },
    },
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
