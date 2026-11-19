import { env } from "@/lib/env";

/**
 * Which browser origins may send sign-in, sign-up and other state-changing
 * requests (CSRF protection).
 *
 * Trusted:
 * - APP_URL;
 * - the addresses Vercel gives the deployment (production domain, branch and
 *   deployment URLs), so the app works even before APP_URL is updated;
 * - TRUSTED_ORIGINS: extra comma-separated origins (e.g. a second domain);
 * - the address the request was sent to. A cross-site page cannot fake this:
 *   its browser sends its own Origin, which won't match the Host the request
 *   arrived at.
 */
export function originOf(value: string | null | undefined): string | null {
  const v = value?.trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  try {
    const url = new URL(v.includes("://") ? v : `https://${v}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredOrigins(): string[] {
  const candidates = [
    env.APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
    ...(process.env.TRUSTED_ORIGINS ?? "").split(","),
  ];
  return [...new Set(candidates.map(originOf).filter((o): o is string => Boolean(o)))];
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/** The origin the request was addressed to, from the Host the platform received. */
export function requestOrigin(headers: Headers): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]?.trim() ?? "";
  if (!HOST.test(host)) return null;
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : isLocal ? "http" : "https";
  return originOf(`${proto}://${host}`);
}

export function trustedOriginsFor(headers?: Headers | null): string[] {
  const fromRequest = headers ? requestOrigin(headers) : null;
  return [...new Set([...configuredOrigins(), ...(fromRequest ? [fromRequest] : [])])];
}

export function isTrustedOrigin(origin: string, headers?: Headers | null): boolean {
  const o = originOf(origin);
  return Boolean(o) && trustedOriginsFor(headers).includes(o as string);
}
