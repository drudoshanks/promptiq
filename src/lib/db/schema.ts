/**
 * Drizzle schema mirroring db/migrations/*.sql (SRS §9).
 *
 * The SQL migrations are the source of truth for the database; this file gives the
 * application typed access to the same tables. Keep the two in sync (a drift test
 * runs the migrations against an embedded PostgreSQL and queries every table).
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// Authentication (Better Auth) — credentials and sessions only.
// TS keys use Better Auth's default field names; DB columns are snake_case.
// ---------------------------------------------------------------------------
export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: tz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("idx_auth_session_user").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tz("access_token_expires_at"),
    refreshTokenExpiresAt: tz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_auth_account_user").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tz("expires_at").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_auth_verification_identifier").on(t.identifier)],
);

/** Schema object handed to Better Auth's Drizzle adapter (model name → table). */
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};

// ---------------------------------------------------------------------------
// Application tables (SRS §9.2)
// ---------------------------------------------------------------------------
export const PLAN_CODES = ["free", "pro"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  authSubject: text("auth_subject").notNull().unique(),
  email: text("email").unique(),
  displayName: text("display_name"),
  planCode: text("plan_code", { enum: PLAN_CODES }).notNull().default("free"),
  historyEnabled: boolean("history_enabled").notNull().default(true),
  personalisationEnabled: boolean("personalisation_enabled").notNull().default(true),
  onboardedAt: tz("onboarded_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
  deletedAt: tz("deleted_at"),
});

export const PREFERENCE_SOURCES = ["user_entered", "user_confirmed", "feedback"] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("general"),
    preferenceKey: text("preference_key").notNull(),
    preferenceValue: jsonb("preference_value").$type<Record<string, unknown>>().notNull(),
    source: text("source", { enum: PREFERENCE_SOURCES }).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("1.000"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("user_preferences_user_id_category_preference_key_key").on(
      t.userId,
      t.category,
      t.preferenceKey,
    ),
    index("idx_preferences_user_enabled").on(t.userId, t.enabled, t.category),
  ],
);

export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled prompt"),
    category: text("category").notNull().default("general"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    archivedAt: tz("archived_at"),
    description: text("description"),
    targetModel: text("target_model"),
    currentVersionId: uuid("current_version_id"),
    isFavourite: boolean("is_favourite").notNull().default(false),
    lastUsedAt: tz("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
    // Denormalised, recomputed by refreshPromptStats() (migration 0004).
    currentVersionNumber: integer("current_version_number").notNull().default(1),
    originalTokenCount: integer("original_token_count"),
    currentTokenCount: integer("current_token_count"),
    optimisationCount: integer("optimisation_count").notNull().default(0),
    latestOptimisationStatus: text("latest_optimisation_status"),
    latestQualityScore: smallint("latest_quality_score"),
    latestAnalysisAt: tz("latest_analysis_at"),
    pendingSuggestionCount: integer("pending_suggestion_count").notNull().default(0),
    pendingPriority: smallint("pending_priority").notNull().default(0),
    latestEstimatedCost: numeric("latest_estimated_cost", { precision: 16, scale: 10 }),
    latestPricingVersion: text("latest_pricing_version"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_prompts_user_updated").on(t.userId, t.updatedAt)],
);

export const PROVENANCES = ["original", "ai_optimised", "user_edited", "imported", "restored", "duplicated", "suggestion_applied"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    parentVersionId: uuid("parent_version_id"),
    provenance: text("provenance", { enum: PROVENANCES }).notNull(),
    promptText: text("prompt_text").notNull(),
    changeSummary: jsonb("change_summary").$type<string[]>().notNull().default([]),
    tokenEstimate: integer("token_estimate"),
    tokenEstimateMethod: text("token_estimate_method"),
    tokenizerVersion: text("tokenizer_version"),
    createdBy: uuid("created_by"),
    optimisationRunId: uuid("optimisation_run_id"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("prompt_versions_prompt_id_version_number_key").on(t.promptId, t.versionNumber),
    index("idx_prompt_versions_prompt_created").on(t.promptId, t.createdAt),
  ],
);

export const RUN_STATUSES = ["queued", "succeeded", "failed", "refused", "incomplete"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const optimisationRuns = pgTable(
  "optimisation_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").references(() => prompts.id, { onDelete: "set null" }),
    sourceVersionId: uuid("source_version_id").references(() => promptVersions.id, {
      onDelete: "set null",
    }),
    resultVersionId: uuid("result_version_id").references(() => promptVersions.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull().default("openai"),
    modelId: text("model_id").notNull(),
    templateVersion: text("template_version").notNull(),
    taskCategory: text("task_category"),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    inputChars: integer("input_chars").notNull(),
    outputChars: integer("output_chars"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    /** Sum of the actual cost of every provider attempt, priced with pricing_version. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    pricingVersion: text("pricing_version"),
    attemptCount: integer("attempt_count").notNull().default(1),
    optimisationMode: text("optimisation_mode", { enum: ["balanced", "token_saver", "quality_first", "custom"] }).notNull().default("balanced"),
    targetModel: text("target_model"),
    tokensSaved: integer("tokens_saved"),
    reductionPercent: numeric("reduction_percent", { precision: 7, scale: 2 }),
    estimatedInputCostBefore: numeric("estimated_input_cost_before", { precision: 16, scale: 10 }),
    estimatedInputCostAfter: numeric("estimated_input_cost_after", { precision: 16, scale: 10 }),
    appliedSuggestionCount: integer("applied_suggestion_count").notNull().default(0),
    latencyMs: integer("latency_ms"),
    requestId: text("request_id"),
    errorCode: text("error_code"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_runs_user_created").on(t.userId, t.createdAt),
    index("idx_runs_status_created").on(t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Token & cost estimation engine (migration 0003)
// ---------------------------------------------------------------------------
export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    pricingVersion: text("pricing_version").notNull().unique(),
    currency: text("currency").notNull().default("USD"),
    inputPerMillion: numeric("input_per_million", { precision: 12, scale: 6 }).notNull(),
    cachedInputPerMillion: numeric("cached_input_per_million", { precision: 12, scale: 6 }),
    outputPerMillion: numeric("output_per_million", { precision: 12, scale: 6 }).notNull(),
    extraPrices: jsonb("extra_prices").$type<Record<string, number>>().notNull().default({}),
    effectiveFrom: tz("effective_from").notNull(),
    effectiveTo: tz("effective_to"),
    source: text("source").notNull(),
    verifiedAt: tz("verified_at").notNull(),
    notes: text("notes"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_model_pricing_lookup").on(t.provider, t.modelId, t.effectiveFrom)],
);

export const ESTIMATE_LABELS = ["original", "optimised", "final", "adhoc"] as const;
export type EstimateLabel = (typeof ESTIMATE_LABELS)[number];

export const tokenEstimates = pgTable(
  "token_estimates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id").references(() => promptVersions.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => optimisationRuns.id, { onDelete: "set null" }),
    label: text("label", { enum: ESTIMATE_LABELS }).notNull(),
    modelId: text("model_id").notNull(),
    encoding: text("encoding").notNull(),
    tokenizerVersion: text("tokenizer_version").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    characterCount: integer("character_count").notNull(),
    expectedOutputTokens: integer("expected_output_tokens").notNull(),
    estimatedInputCost: numeric("estimated_input_cost", { precision: 16, scale: 10 }),
    estimatedOutputCost: numeric("estimated_output_cost", { precision: 16, scale: 10 }),
    estimatedTotalCost: numeric("estimated_total_cost", { precision: 16, scale: 10 }),
    pricingVersion: text("pricing_version"),
    currency: text("currency").notNull().default("USD"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_token_estimates_user_created").on(t.userId, t.createdAt),
    index("idx_token_estimates_version").on(t.promptVersionId),
    index("idx_token_estimates_run").on(t.runId),
  ],
);

export const USAGE_RECORD_STATUSES = ["ok", "refused", "incomplete", "invalid_output", "error"] as const;
export type UsageRecordStatus = (typeof USAGE_RECORD_STATUSES)[number];

export const apiUsageRecords = pgTable(
  "api_usage_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => optimisationRuns.id, { onDelete: "set null" }),
    analysisId: uuid("analysis_id"),
    attempt: integer("attempt").notNull().default(1),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    requestType: text("request_type").notNull(),
    providerRequestId: text("provider_request_id"),
    status: text("status", { enum: USAGE_RECORD_STATUSES }).notNull(),
    usageReported: boolean("usage_reported").notNull().default(true),
    actualInputTokens: integer("actual_input_tokens").notNull(),
    actualOutputTokens: integer("actual_output_tokens").notNull(),
    actualTotalTokens: integer("actual_total_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens"),
    actualCost: numeric("actual_cost", { precision: 16, scale: 10 }),
    pricingVersion: text("pricing_version"),
    currency: text("currency").notNull().default("USD"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("api_usage_records_run_id_attempt_key").on(t.runId, t.attempt),
    index("idx_api_usage_user_created").on(t.userId, t.createdAt),
    index("idx_api_usage_model_created").on(t.modelId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Prompt library: analyses, suggestions, prompt preferences (migration 0004)
// ---------------------------------------------------------------------------
export const ANALYSIS_STATUSES = ["running", "completed", "failed"] as const;

export const promptAnalyses = pgTable(
  "prompt_analyses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ANALYSIS_STATUSES }).notNull(),
    qualityScore: smallint("quality_score"),
    alreadyOptimised: boolean("already_optimised").notNull().default(false),
    analysisResult: jsonb("analysis_result").$type<Record<string, unknown>>().notNull().default({}),
    targetModel: text("target_model"),
    modelId: text("model_id").notNull(),
    templateVersion: text("template_version").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    actualCost: numeric("actual_cost", { precision: 16, scale: 10 }),
    errorCode: text("error_code"),
    createdAt: tz("created_at").notNull().defaultNow(),
    completedAt: tz("completed_at"),
  },
  (t) => [index("idx_analyses_prompt_created").on(t.promptId, t.createdAt), index("idx_analyses_user_created").on(t.userId, t.createdAt)],
);

export const SUGGESTION_STATUSES = ["pending", "accepted", "dismissed", "deferred", "applied"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export const SUGGESTION_PRIORITIES = ["high", "medium", "low"] as const;
export type SuggestionPriority = (typeof SUGGESTION_PRIORITIES)[number];

export const promptSuggestions = pgTable(
  "prompt_suggestions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => promptAnalyses.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    promptVersionId: uuid("prompt_version_id")
      .notNull()
      .references(() => promptVersions.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    category: text("category").notNull(),
    priority: text("priority", { enum: SUGGESTION_PRIORITIES }).notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    recommendation: text("recommendation").notNull(),
    estimatedTokenImpact: text("estimated_token_impact", { enum: ["none", "low", "medium", "high"] }),
    tokenDirection: text("token_direction", { enum: ["reduce", "increase", "neutral"] }),
    requiresUserContext: boolean("requires_user_context").notNull().default(false),
    contextQuestion: text("context_question"),
    status: text("status", { enum: SUGGESTION_STATUSES }).notNull().default("pending"),
    appliedVersionId: uuid("applied_version_id"),
    feedbackAt: tz("feedback_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("prompt_suggestions_analysis_id_position_key").on(t.analysisId, t.position),
    index("idx_suggestions_prompt_status").on(t.promptId, t.status),
    index("idx_suggestions_user_status").on(t.userId, t.status, t.createdAt),
  ],
);

export const OPTIMISATION_MODES = ["balanced", "token_saver", "quality_first", "custom"] as const;
export type OptimisationMode = (typeof OPTIMISATION_MODES)[number];

export const userPromptPreferences = pgTable("user_prompt_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => appUsers.id, { onDelete: "cascade" }),
  preferredModel: text("preferred_model"),
  preferredStyle: text("preferred_style", { enum: ["natural", "structured", "bullet_points", "step_by_step"] }),
  preferredResponseLength: text("preferred_response_length", { enum: ["short", "medium", "long"] }),
  tokenEfficiencyPriority: text("token_efficiency_priority", { enum: ["low", "balanced", "high"] }).notNull().default("balanced"),
  defaultOptimisationMode: text("default_optimisation_mode", { enum: ["balanced", "token_saver", "quality_first"] }).notNull().default("balanced"),
  domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
  learnFromFeedback: boolean("learn_from_feedback").notNull().default(true),
  backgroundAnalysis: boolean("background_analysis").notNull().default(false),
  preferencesJson: jsonb("preferences_json").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => optimisationRuns.id, { onDelete: "cascade" }),
    rating: smallint("rating").notNull(),
    reasonCode: text("reason_code"),
    comment: text("comment"),
    preferenceSuggestion: jsonb("preference_suggestion").$type<Record<string, unknown>>(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("feedback_user_id_run_id_key").on(t.userId, t.runId)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => optimisationRuns.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    units: integer("units").notNull().default(1),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    idempotencyKey: text("idempotency_key").unique(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_usage_user_created").on(t.userId, t.createdAt),
    index("idx_usage_type_created").on(t.eventType, t.createdAt),
  ],
);

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "none",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    billingProvider: text("billing_provider").notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id").unique(),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
    currentPeriodStart: tz("current_period_start"),
    currentPeriodEnd: tz("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("idx_subscriptions_customer").on(t.providerCustomerId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: tz("processed_at"),
    processingStatus: text("processing_status", {
      enum: ["received", "processed", "failed"],
    })
      .notNull()
      .default("received"),
    errorCode: text("error_code"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [unique("webhook_events_provider_provider_event_id_key").on(t.provider, t.providerEventId)],
);

export const deletionJobs = pgTable(
  "deletion_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull(),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] })
      .notNull()
      .default("pending"),
    requestedAt: tz("requested_at").notNull().defaultNow(),
    completedAt: tz("completed_at"),
    errorCode: text("error_code"),
  },
  (t) => [index("idx_deletion_jobs_user").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Relations (for the relational query API)
// ---------------------------------------------------------------------------
export const promptsRelations = relations(prompts, ({ many, one }) => ({
  versions: many(promptVersions),
  owner: one(appUsers, { fields: [prompts.userId], references: [appUsers.id] }),
}));

export const promptVersionsRelations = relations(promptVersions, ({ one }) => ({
  prompt: one(prompts, { fields: [promptVersions.promptId], references: [prompts.id] }),
}));

export const promptAnalysesRelations = relations(promptAnalyses, ({ many }) => ({
  suggestions: many(promptSuggestions),
}));

export const promptSuggestionsRelations = relations(promptSuggestions, ({ one }) => ({
  analysis: one(promptAnalyses, { fields: [promptSuggestions.analysisId], references: [promptAnalyses.id] }),
}));

export const appUsersRelations = relations(appUsers, ({ many, one }) => ({
  prompts: many(prompts),
  preferences: many(userPreferences),
  subscription: one(subscriptions, {
    fields: [appUsers.id],
    references: [subscriptions.userId],
  }),
}));

export type AppUser = typeof appUsers.$inferSelect;
export type UserPreference = typeof userPreferences.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type PromptVersion = typeof promptVersions.$inferSelect;
export type OptimisationRun = typeof optimisationRuns.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type DeletionJob = typeof deletionJobs.$inferSelect;
export type ModelPricing = typeof modelPricing.$inferSelect;
export type TokenEstimate = typeof tokenEstimates.$inferSelect;
export type ApiUsageRecord = typeof apiUsageRecords.$inferSelect;
export type PromptAnalysis = typeof promptAnalyses.$inferSelect;
export type PromptSuggestion = typeof promptSuggestions.$inferSelect;
export type UserPromptPreferences = typeof userPromptPreferences.$inferSelect;
