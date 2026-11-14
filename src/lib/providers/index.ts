import "server-only";

import { env } from "@/lib/env";

import { AnthropicProvider } from "./anthropic";
import { FallbackProvider } from "./fallback";
import { MockOptimiserProvider } from "./mock";
import { OpenModelProvider } from "./open-model";
import { OpenAIOptimiserProvider } from "./openai";
import type { AiProvider } from "./types";

declare global {
  var __promptiqProvider: AiProvider | undefined;
}

const rulesFallbackEnabled = () => (env.OPTIMISER_FALLBACK ?? env.OPEN_MODEL_FALLBACK ?? "rules") === "rules";

function build(): AiProvider {
  switch (env.OPTIMISER_PROVIDER) {
    case "anthropic": {
      const claude = new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY as string,
        ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
        modelId: env.ANTHROPIC_MODEL,
        timeoutMs: env.ANTHROPIC_TIMEOUT_MS,
        effort: env.ANTHROPIC_EFFORT,
      });
      return rulesFallbackEnabled() ? new FallbackProvider(claude, new MockOptimiserProvider()) : claude;
    }
    case "open": {
      const open = new OpenModelProvider({
        baseUrl: env.OPEN_MODEL_BASE_URL,
        ...(env.OPEN_MODEL_API_KEY ? { apiKey: env.OPEN_MODEL_API_KEY } : {}),
        modelId: env.OPEN_MODEL,
        timeoutMs: env.OPEN_MODEL_TIMEOUT_MS,
        outputMode: env.OPEN_MODEL_OUTPUT,
      });
      return rulesFallbackEnabled() ? new FallbackProvider(open, new MockOptimiserProvider()) : open;
    }
    case "openai":
      return new OpenAIOptimiserProvider({
        apiKey: env.OPENAI_API_KEY as string,
        modelId: env.OPTIMISER_MODEL,
        timeoutMs: env.OPTIMISER_TIMEOUT_MS,
        reasoningEffort: env.OPTIMISER_REASONING_EFFORT,
      });
    default:
      return new MockOptimiserProvider({ latencyMs: 400 });
  }
}

/** Process-wide provider instance so the circuit breaker state is shared. */
export function getOptimiserProvider(): AiProvider {
  if (globalThis.__promptiqProvider) return globalThis.__promptiqProvider;
  const provider = build();
  globalThis.__promptiqProvider = provider;
  return provider;
}

/** Model ID of the configured provider, for display. */
export function configuredModelId(): string {
  if (env.OPTIMISER_PROVIDER === "anthropic") return env.ANTHROPIC_MODEL;
  if (env.OPTIMISER_PROVIDER === "open") return env.OPEN_MODEL;
  if (env.OPTIMISER_PROVIDER === "openai") return env.OPTIMISER_MODEL;
  return "mock-optimiser";
}
