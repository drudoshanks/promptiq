import "server-only";

import { env } from "@/lib/env";

import { MockOptimiserProvider } from "./mock";
import { OpenAIOptimiserProvider } from "./openai";
import type { OptimiserProvider } from "./types";

declare global {
  var __promptiqProvider: OptimiserProvider | undefined;
}

/** Process-wide provider instance so the circuit breaker state is shared. */
export function getOptimiserProvider(): OptimiserProvider {
  if (globalThis.__promptiqProvider) return globalThis.__promptiqProvider;
  const provider: OptimiserProvider =
    env.OPTIMISER_PROVIDER === "openai"
      ? new OpenAIOptimiserProvider({
          apiKey: env.OPENAI_API_KEY as string,
          modelId: env.OPTIMISER_MODEL,
          timeoutMs: env.OPTIMISER_TIMEOUT_MS,
          reasoningEffort: env.OPTIMISER_REASONING_EFFORT,
        })
      : new MockOptimiserProvider({ latencyMs: 400 });
  globalThis.__promptiqProvider = provider;
  return provider;
}
