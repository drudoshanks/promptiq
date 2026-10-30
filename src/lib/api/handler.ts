import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { type ZodType } from "zod";

import { getCurrentUserFromHeaders, type CurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { logger, type RequestLogger } from "@/lib/logger";

import { AppError, forbidden, toAppError, unauthenticated } from "./errors";
import { checkRateLimit, RATE_LIMITS } from "./rate-limit";

export interface ApiResult {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export type AuthMode = "required" | "admin" | "optional" | "none";

/** The user is guaranteed for "required"/"admin" and nullable otherwise. */
export type UserFor<A extends AuthMode> = A extends "required" | "admin" ? CurrentUser : CurrentUser | null;

export interface ApiContext<TParams extends Record<string, string> = Record<string, string>, TUser = CurrentUser | null> {
  request: NextRequest;
  requestId: string;
  log: RequestLogger;
  params: TParams;
  user: TUser;
  idempotencyKey: string | null;
}

export interface ApiOptions<A extends AuthMode = AuthMode> {
  auth: A;
  /** Additional per-user limit (IP limits always apply). */
  rateLimit?: keyof typeof RATE_LIMITS;
  /** Same-origin check for state-changing requests (default true). */
  csrf?: boolean;
}

type RouteContext = { params: Promise<Record<string, string>> };
type Handler<TParams extends Record<string, string>, A extends AuthMode> = (
  ctx: ApiContext<TParams, UserFor<A>>,
) => Promise<ApiResult | Response>;

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const appOrigin = new URL(env.APP_URL).origin;
  if (origin) return origin === appOrigin;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  // Non-browser clients (curl, tests) send neither header; cookie-less bearer
  // style calls are not CSRF-exposed. Browser requests always carry Origin on
  // POST/PATCH/DELETE in current browsers.
  return true;
}

function envelope(requestId: string, result: ApiResult): NextResponse {
  const status = result.status ?? 200;
  const headers = new Headers({ "X-Request-Id": requestId, ...(result.headers ?? {}) });
  if (status === 204) return new NextResponse(null, { status, headers });
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new NextResponse(JSON.stringify({ data: result.data ?? null, request_id: requestId }), { status, headers });
}

function errorResponse(requestId: string, error: AppError): NextResponse {
  return NextResponse.json(error.toEnvelope(requestId), {
    status: error.status,
    headers: { "X-Request-Id": requestId, ...error.headers },
  });
}

/**
 * Wrap a Next.js route handler with the API conventions of SRS §10.1:
 * request IDs, authentication, rate limits, CSRF origin checks, consistent
 * success/error envelopes and redacted error logging.
 */
export function withApi<A extends AuthMode, TParams extends Record<string, string> = Record<string, string>>(
  options: ApiOptions<A>,
  handler: Handler<TParams, A>,
) {
  return async (request: NextRequest, context: RouteContext): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const log = logger.withRequest(requestId);
    const startedAt = Date.now();
    const method = request.method.toUpperCase();

    try {
      const ipLimit = checkRateLimit(`ip:${clientIp(request)}`, RATE_LIMITS.ipPerMinute.limit, RATE_LIMITS.ipPerMinute.windowMs);
      if (!ipLimit.allowed) {
        throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", {
          headers: { "Retry-After": String(ipLimit.retryAfterSeconds) },
        });
      }

      if ((options.csrf ?? true) && method !== "GET" && method !== "HEAD" && !sameOrigin(request)) {
        throw new AppError("FORBIDDEN", "Cross-site request rejected.");
      }

      let user: CurrentUser | null = null;
      if (options.auth !== "none") {
        user = await getCurrentUserFromHeaders(request.headers);
        if (!user && options.auth !== "optional") throw unauthenticated();
        if (options.auth === "admin" && !user?.isAdmin) throw forbidden("Operator access required.");
      }

      if (user && options.rateLimit) {
        const spec = RATE_LIMITS[options.rateLimit];
        const limit = checkRateLimit(`user:${user.id}:${options.rateLimit}`, spec.limit, spec.windowMs);
        if (!limit.allowed) {
          throw new AppError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", {
            headers: { "Retry-After": String(limit.retryAfterSeconds) },
            details: { retry_after_seconds: limit.retryAfterSeconds },
          });
        }
      }

      const params = (await context.params) as TParams;
      const idempotencyKey = request.headers.get("idempotency-key")?.trim().slice(0, 128) || null;

      const result = await handler({ request, requestId, log, params, user: user as UserFor<A>, idempotencyKey });
      const response = result instanceof Response ? result : envelope(requestId, result);
      if (!response.headers.has("X-Request-Id")) response.headers.set("X-Request-Id", requestId);
      log.debug("request completed", { method, path: request.nextUrl.pathname, status: response.status, latency_ms: Date.now() - startedAt });
      return response;
    } catch (error) {
      const appError = toAppError(error);
      if (appError.status >= 500) {
        log.error("request failed", {
          method,
          path: request.nextUrl.pathname,
          code: appError.code,
          message: error instanceof Error ? error.message : String(error),
          stack: env.NODE_ENV === "production" ? undefined : (error as Error)?.stack,
        });
      } else {
        log.info("request rejected", { method, path: request.nextUrl.pathname, code: appError.code, status: appError.status });
      }
      return errorResponse(requestId, appError);
    }
  };
}

/** Parse and validate a JSON body; invalid JSON and schema failures become 400s. */
export async function parseJson<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Content-Type must be application/json.");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body is not valid JSON.");
  }
  return schema.parse(body);
}

export function parseQuery<T>(request: NextRequest, schema: ZodType<T>): T {
  const raw: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  return schema.parse(raw);
}

export const ok = (data: unknown, headers?: Record<string, string>): ApiResult => ({ status: 200, data, headers });
export const created = (data: unknown): ApiResult => ({ status: 201, data });
export const accepted = (data: unknown): ApiResult => ({ status: 202, data });
export const noContent = (): ApiResult => ({ status: 204 });
