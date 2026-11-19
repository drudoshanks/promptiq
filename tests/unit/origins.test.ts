import { afterEach, describe, expect, it } from "vitest";

import { configuredOrigins, isTrustedOrigin, originOf, requestOrigin } from "@/lib/auth/origins";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "TRUSTED_ORIGINS"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const headers = (h: Record<string, string>) => new Headers(h);

describe("trusted origins", () => {
  it("normalises origins", () => {
    expect(originOf("https://promptiq.app/sign-up")).toBe("https://promptiq.app");
    expect(originOf(" promptiq-abc.vercel.app ")).toBe("https://promptiq-abc.vercel.app");
    expect(originOf('"https://promptiq.app/"')).toBe("https://promptiq.app");
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("")).toBeNull();
  });

  it("trusts APP_URL, Vercel's addresses and TRUSTED_ORIGINS", () => {
    process.env.VERCEL_URL = "promptiq-8f3k2-team.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "promptiq.vercel.app";
    process.env.TRUSTED_ORIGINS = "https://www.promptiq.in, https://promptiq.in";
    expect(configuredOrigins()).toEqual(
      expect.arrayContaining(["http://localhost:3000", "https://promptiq.vercel.app", "https://promptiq-8f3k2-team.vercel.app", "https://www.promptiq.in", "https://promptiq.in"]),
    );
    expect(isTrustedOrigin("https://promptiq.vercel.app")).toBe(true);
    expect(isTrustedOrigin("https://evil.example")).toBe(false);
  });

  it("trusts the address the request was sent to, and nothing else", () => {
    const h = headers({ host: "internal:3000", "x-forwarded-host": "promptiq-git-main-team.vercel.app", "x-forwarded-proto": "https" });
    expect(requestOrigin(h)).toBe("https://promptiq-git-main-team.vercel.app");
    expect(isTrustedOrigin("https://promptiq-git-main-team.vercel.app", h)).toBe(true);
    // A cross-site page sends its own Origin, which doesn't match the Host.
    expect(isTrustedOrigin("https://evil.example", h)).toBe(false);
    expect(isTrustedOrigin("http://promptiq-git-main-team.vercel.app", h)).toBe(false);
  });

  it("ignores malformed hosts", () => {
    expect(requestOrigin(headers({ host: "evil.example/@x" }))).toBeNull();
    expect(requestOrigin(headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(requestOrigin(headers({ host: "promptiq.app" }))).toBe("https://promptiq.app");
  });
});
