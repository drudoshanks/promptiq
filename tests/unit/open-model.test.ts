// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FallbackProvider } from "@/lib/providers/fallback";
import { MockOptimiserProvider } from "@/lib/providers/mock";
import { extractJsonObject, OpenModelProvider, parseChatUsage } from "@/lib/providers/open-model";
import { ProviderError } from "@/lib/providers/types";

/**
 * A stand-in for an OpenAI-compatible server (Ollama, vLLM, Groq ...), driven
 * through the real OpenAI SDK over HTTP so request shape and error mapping are
 * exercised exactly as in production.
 */
type Reply = { status: number; body: unknown };
let queue: Reply[] = [];
let requests: Array<Record<string, unknown>> = [];
let server: Server;
let baseUrl = "";

const revision = { revised_prompt: "Write a blog post for HR managers. Under 500 words.", key_improvements: ["Clearer"], assumptions_introduced: [], clarification_questions: [] };
const completion = (content: string, finish = "stop") => ({
  status: 200,
  body: { id: "c1", object: "chat.completion", created: 1, model: "qwen2.5:7b", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } },
});

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ path: req.url, ...(JSON.parse(raw || "{}") as Record<string, unknown>) });
      const next = queue.shift() ?? { status: 500, body: { error: { message: "no reply queued" } } };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  queue = [];
  requests = [];
});

const provider = (extra: Partial<ConstructorParameters<typeof OpenModelProvider>[0]> = {}) =>
  new OpenModelProvider({ baseUrl, modelId: "qwen2.5:7b", timeoutMs: 5000, sleep: async () => undefined, ...extra });

const compare = { items: [{ id: "r1", text: "Keep it under 500 words." }], revised: "Under 500 words.", requestId: "t", userKey: "u" };

describe("open model provider (OpenAI-compatible chat API)", () => {
  it("sends a chat completion with a strict JSON schema and records usage", async () => {
    queue.push(completion(JSON.stringify({ items: [{ id: "r1", status: "preserved", note: null }] })));
    const result = await provider().compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect(requests[0]?.path).toBe("/v1/chat/completions");
    expect(requests[0]?.model).toBe("qwen2.5:7b");
    expect((requests[0]?.response_format as { type: string }).type).toBe("json_schema");
    expect(result.attempts).toEqual([expect.objectContaining({ status: "ok", usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, cachedInputTokens: null } })]);
  });

  it("accepts JSON wrapped in reasoning tags or a code fence", async () => {
    queue.push(completion(`<think>Check each item.</think>\nHere you go:\n\`\`\`json\n${JSON.stringify({ items: [{ id: "r1", status: "preserved", note: null }] })}\n\`\`\``));
    const result = await provider().compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect(result.attempts).toHaveLength(1);
    expect(extractJsonObject(`<think>x</think>\`\`\`json\n${JSON.stringify(revision)}\n\`\`\``)).toEqual(revision);
    expect(extractJsonObject("Sure! " + JSON.stringify(revision) + " Hope that helps.")).toEqual(revision);
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("repairs once after malformed output, then reports invalid_output", async () => {
    queue.push(completion("not json"), completion("still not json"));
    const result = await provider().compareRequirements(compare);
    expect(result.kind).toBe("invalid_output");
    expect(result.attempts.map((a) => a.status)).toEqual(["invalid_output", "invalid_output"]);
  });

  it("reports a truncated answer as incomplete", async () => {
    queue.push(completion('{"items": [', "length"));
    const result = await provider().compareRequirements(compare);
    expect(result.kind).toBe("incomplete");
  });

  it("switches to json_object when the host rejects json_schema", async () => {
    queue.push({ status: 400, body: { error: { message: "response_format json_schema is not supported" } } }, completion(JSON.stringify({ items: [{ id: "r1", status: "preserved", note: null }] })));
    const p = provider();
    const result = await p.compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect((requests[1]?.response_format as { type: string }).type).toBe("json_object");
    expect(JSON.stringify(requests[1]?.messages)).toContain("JSON Schema");
  });

  it("does not retry a missing model and says so", async () => {
    queue.push({ status: 404, body: { error: { message: "model 'qwen2.5:7b' not found" } } });
    const error = await provider().compareRequirements(compare).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("model_not_found");
    expect(requests).toHaveLength(1);
  });

  it("maps an unreachable server to connection_error after one retry", async () => {
    const p = new OpenModelProvider({ baseUrl: "http://127.0.0.1:9/v1", modelId: "m", timeoutMs: 2000, sleep: async () => undefined });
    const error = await p.compareRequirements(compare).catch((e: unknown) => e);
    expect((error as ProviderError).reason).toBe("connection_error");
    expect((error as ProviderError).attempts).toHaveLength(2);
  });

  it("parses chat usage including cached tokens", () => {
    expect(parseChatUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 10 });
    expect(parseChatUsage(undefined)).toBeNull();
  });
});

describe("rule-based fallback", () => {
  it("answers with the rule-based engine when the model server is down, keeping the failed attempts", async () => {
    const open = new OpenModelProvider({ baseUrl: "http://127.0.0.1:9/v1", modelId: "m", timeoutMs: 2000, sleep: async () => undefined });
    const p = new FallbackProvider(open, new MockOptimiserProvider());
    expect(p.name).toBe("open");
    const result = await p.compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect(result.modelId).toBe("mock-optimiser");
    expect(result.attempts.map((a) => [a.attempt, a.status, a.modelId])).toEqual([
      [1, "error", "m"],
      [2, "error", "m"],
      [3, "ok", "mock-optimiser"],
    ]);
  });

  it("uses the rule-based engine when the model keeps returning unusable output", async () => {
    queue.push(completion("nope"), completion("nope"));
    const p = new FallbackProvider(provider(), new MockOptimiserProvider());
    const result = await p.compareRequirements(compare);
    expect(result.kind).toBe("ok");
    expect(result.attempts).toHaveLength(3);
  });
});
