/**
 * Structured JSON logger (NFR-008). Prompt content is never passed to it: callers
 * log identifiers, timings, status and model metadata only. A redaction pass
 * strips the few field names that could carry user text if a caller slips.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  "prompt",
  "prompt_text",
  "promptText",
  "optimised_prompt",
  "optimisedPrompt",
  "input",
  "output",
  "comment",
  "authorization",
  "cookie",
  "api_key",
  "apiKey",
  "password",
  "token",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (raw in LEVEL_RANK ? raw : "info") as Level;
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
  /** Child logger that attaches a correlation ID to every entry. */
  withRequest(requestId: string) {
    return {
      debug: (msg: string, f?: Record<string, unknown>) =>
        write("debug", msg, { request_id: requestId, ...f }),
      info: (msg: string, f?: Record<string, unknown>) =>
        write("info", msg, { request_id: requestId, ...f }),
      warn: (msg: string, f?: Record<string, unknown>) =>
        write("warn", msg, { request_id: requestId, ...f }),
      error: (msg: string, f?: Record<string, unknown>) =>
        write("error", msg, { request_id: requestId, ...f }),
    };
  },
};

export type RequestLogger = ReturnType<typeof logger.withRequest>;
