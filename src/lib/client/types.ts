/** Response shapes consumed by the browser (mirror the serialisers in src/lib). */
import type { OptimisationResponse } from "@/lib/optimiser/service";
import type { SerialisedPreference } from "@/lib/services/preferences";
import type { SerialisedPrompt, SerialisedVersion } from "@/lib/services/prompts";

export type { OptimisationResponse, SerialisedPreference, SerialisedPrompt, SerialisedVersion };

export interface PromptListResponse {
  items: Array<SerialisedPrompt & { version_count: number; latest_version: SerialisedVersion | null }>;
  page: number;
  page_size: number;
  total: number;
}

export interface PromptDetailResponse extends SerialisedPrompt {
  versions: SerialisedVersion[];
}

export interface FeedbackResponse {
  id: string;
  run_id: string;
  rating: number;
  reason_code: string | null;
  comment: string | null;
  saved_preference: SerialisedPreference | null;
}

export interface UsageResponse {
  plan: { code: string; name: string };
  period: { start: string; end: string; source: string };
  optimisations: { used: number; limit: number; remaining: number };
  saved_prompts: { used: number; limit: number };
  tokens: { input: number; output: number };
  estimated_provider_cost_usd: number;
  subscription: { status: string; cancel_at_period_end: boolean; current_period_end: string | null } | null;
}
