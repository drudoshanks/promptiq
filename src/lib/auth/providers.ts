import "server-only";

import { features } from "@/lib/env";

/** Social providers that are configured for this deployment. */
export function enabledProviders(): Array<"google" | "github"> {
  const providers: Array<"google" | "github"> = [];
  if (features.googleAuth) providers.push("google");
  if (features.githubAuth) providers.push("github");
  return providers;
}

/** Only same-site relative paths are accepted as post-sign-in destinations. */
export function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/app";
  return value;
}
