/**
 * Short-lived, per-user cache for dashboard summaries (Prompt Library §12).
 * Invalidated by every write that changes a prompt's library stats
 * (refreshPromptStats, deletion, favourite/usage changes); the TTL bounds
 * staleness on multi-instance deployments where invalidation is per-process.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

export function getCached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) return undefined;
  return hit.value as T;
}

export function setCached(key: string, value: unknown): void {
  cache.set(key, { expiresAt: Date.now() + TTL_MS, value });
  if (cache.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k);
  }
}

export function invalidateDashboard(userId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${userId}:`)) cache.delete(key);
}
