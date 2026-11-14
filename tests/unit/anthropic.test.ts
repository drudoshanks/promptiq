// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AnthropicProvider, parseClaudeUsage, toClaudeSchema } from "@/lib/providers/anthropic";
import { FallbackProvider } from "@/lib/providers/fallback";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { ProviderError } from "@/lib/providers/types";

/** A stand-in for the Claude Messages API, driven through the real @anthropic-ai/sdk over HTTP. */
type Reply = { status: number; body: unknown };
let queue: Reply[] = [];
let requests: Array<Record<string, unknown>> = [];
let server: Server;
let baseUrl = "";

const ok = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [
      { type: "thinking", thinking: "Checking each requirement.", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    ...extra,
  },
});
const apiError = (status: number, type: string, message: string) => ({ status, body: { type: "error", error: { type, message } } });
const COMPARE_OK = JSON.stringify({ items: [{ id: "r1", status: "preserved", note: null }] });
const compare = { items: [{ id: "r1", text: "Keep it under 500 words." }], revised: "Under 500 words.", requestId: "t", userKey: "u" };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ path: req.url, apiKey: req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, ""), ...(JSON.parse(raw || "{}") as Record<string, unknown>) });
      const next = queue.shift() ?? apiError(500, "api_error", "no reply queued");
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  queue = [];
  requests = [];
});

const claude = (extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) =>
  new AnthropicProvider({ apiKey: "sk-ant-test", baseUrl, modelId: "claude-sonnet-5-5", timeoutMs: 5000, sleep: async () => undefined, ...extra });

describe("Claude provider", () => {
  it("sends structured-output requests with low effort and a cached system prompt, and reads the answer after thinking", async () => {
    queue.push(ok(COMPARE_OK));
    const result = await claude().compareRequirements(compare);
    expect(result.kind).toBe("ok");
    const req = requests[0]!;
    expect(req.path).toBe("/v1/messages");
    expect(req.apiKey).toBe("sk-ant-test");
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.output_config).toMatchObject({ effort: "low", format: { type: "json_schema", schema: { type: "object", additionalProperties: false } } });
    expect(req.system).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } })]);
    expect(req.max_tokens).toBe(1500 + 8000);
    // Cache reads count as input (and as cached input) for cost accounting.
    expect(result.attempts).toEqual([expect.objectContaining({ status: "ok", modelId: "claude-sonnet-5-5", usage: { inputTokens: 1020, outputTokens: 60, totalTokens: 1080, cachedInputTokens: 900 } })]);
  });

  it("reports refusals and truncated answers", async () => {
    queue.push(ok("I can't help with that.", { stop_reason: "refusal" }), ok('{"items": [', { stop_reason: "max_tokens" }));
    expect(await claude().compareRequirements(compare)).toMatchObject({ kind: "refused", reason: "I can't help with that." });
    expect(await claude().compareRequirements(compare)).toMatchObject({ kind: "incomplete" });
  });

  it("repairs once after unusable output", async () => {
    queue.push(ok("not json"), ok(COMPARE_OK));
    const result = await claude().compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect(result.attempts.map((a) => a.status)).toEqual(["invalid_output", "ok"]);
  });

  it("falls back to plain JSON if Claude rejects the schema", async () => {
    queue.push(apiError(400, "invalid_request_error", "Schema is too complex for compilation."), ok(COMPARE_OK));
    const result = await claude().compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect((requests[1]!.output_config as Record<string, unknown>).format).toBeUndefined();
    expect(JSON.stringify(requests[1]!.system)).toContain("JSON Schema");
  });

  it.each([
    [apiError(401, "authentication_error", "invalid x-api-key"), "auth_error"],
    [apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "insufficient_credit"],
    [apiError(404, "not_found_error", "model: claude-nope"), "model_not_found"],
  ])("does not retry configuration problems (%#)", async (reply, reason) => {
    queue.push(reply);
    const error = await claude().compareRequirements(compare).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe(reason);
    expect(requests).toHaveLength(1);
  });

  it("retries once when Claude is overloaded", async () => {
    queue.push(apiError(529, "overloaded_error", "Overloaded"), apiError(529, "overloaded_error", "Overloaded"));
    const error = await claude().compareRequirements(compare).catch((e: unknown) => e);
    expect((error as ProviderError).reason).toBe("upstream_overloaded");
    expect(requests).toHaveLength(2);
  });

  it("falls back to the rule-based engine when Claude is unreachable", async () => {
    const p = new FallbackProvider(claude({ baseUrl: "http://127.0.0.1:9" }), new MockOptimiserProvider());
    expect(p.name).toBe("anthropic");
    const result = await p.compareRequirements(compare);
    expect(result).toMatchObject({ kind: "ok", modelId: "mock-optimiser" });
  });
});

describe("schemas sent to Claude", () => {
  const schemas = claude().schemas;
  const walk = (node: unknown, visit: (n: Record<string, unknown>) => void) => {
    if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
    else if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      Object.values(node as Record<string, unknown>).forEach((v) => walk(v, visit));
    }
  };

  it.each(Object.keys(schemas))("%s stays within Claude's structured-output limits", (name) => {
    let unions = 0;
    let optional = 0;
    walk(schemas[name], (n) => {
      if (n.type === "object" || n.properties) {
        expect(n.additionalProperties).toBe(false);
        const props = Object.keys((n.properties as object) ?? {});
        optional += props.filter((p) => !((n.required as string[]) ?? []).includes(p)).length;
      }
      if (Array.isArray(n.anyOf) || Array.isArray(n.type)) unions += 1;
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "maxItems", "pattern", "$schema"]) expect(n).not.toHaveProperty(k);
      if (typeof n.minItems === "number") expect(n.minItems).toBeLessThanOrEqual(1);
    });
    expect(unions).toBeLessThanOrEqual(16);
    expect(optional).toBeLessThanOrEqual(24);
  });

  it("strips unsupported constraints and closes objects", () => {
    expect(toClaudeSchema({ $schema: "x", type: "object", properties: { n: { type: "number", minimum: 0, maximum: 1 }, s: { type: "string", maxLength: 5, format: "regex" }, a: { type: "array", minItems: 3, maxItems: 9, items: { type: "object", properties: {} } } } })).toEqual({
      type: "object",
      properties: { n: { type: "number" }, s: { type: "string" }, a: { type: "array", minItems: 1, items: { type: "object", properties: {}, additionalProperties: false } } },
      additionalProperties: false,
    });
  });

  it("parses usage", () => {
    expect(parseClaudeUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: null });
    expect(parseClaudeUsage(null)).toBeNull();
  });
});
