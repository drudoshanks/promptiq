import type { NextConfig } from "next";

/**
 * Security headers applied to every response (NFR-001, §12).
 * The CSP is deliberately strict: no inline scripts other than Next's own hashed
 * runtime, no third-party origins except Stripe-hosted checkout/portal redirects
 * (which are full-page navigations, not embeds).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // The OpenAI tokenizer and SDK are server-only; keep them out of the client bundle.
  serverExternalPackages: ["js-tiktoken", "openai", "pg"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
