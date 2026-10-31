import "server-only";

import { z } from "zod";

/**
 * Server environment, validated once at startup. Secrets never leave this module
 * for the client bundle: nothing here is prefixed NEXT_PUBLIC_.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("PromptIQ <no-reply@example.com>"),

  OPTIMISER_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  OPENAI_API_KEY: z.string().optional(),
  OPTIMISER_MODEL: z.string().default("gpt-5-mini"),
  OPTIMISER_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high", ""])
    .optional()
    .transform((v) => (v ? v : undefined)),
  OPTIMISER_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(300).max(8000).default(1500),
  OPTIMISER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  GLOBAL_DAILY_SPEND_CAP_USD: z.coerce.number().min(0).default(25),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),

  // UPI payments (manual verification). Payments are disabled until UPI_VPA is set.
  UPI_VPA: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().toLowerCase())
    .refine((v) => v === "" || /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/.test(v), "UPI_VPA must look like name@bank"),
  UPI_PAYEE_NAME: z
    .string()
    .default("PromptIQ")
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .refine((v) => /^[A-Za-z0-9 .&'-]{2,50}$/.test(v), "UPI_PAYEE_NAME may contain letters, digits, spaces and . & ' - (2–50 characters)"),
  UPI_REQUEST_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(48),
  PAYMENT_SCREENSHOT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(180),

  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.OPTIMISER_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when OPTIMISER_PROVIDER=openai");
  }
  return env;
}

export const env: Env = loadEnv();

export const features = {
  googleAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  githubAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  billing: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO_MONTHLY),
  email: Boolean(env.RESEND_API_KEY),
  upiPayments: Boolean(env.UPI_VPA),
};
