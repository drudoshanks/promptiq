import { ZodError } from "zod";

/**
 * Error codes and HTTP mapping (SRS §10.6). Every API error is an AppError so the
 * handler wrapper can render the consistent envelope without leaking internals.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  REAUTH_REQUIRED: 403,
  VALIDATION_ERROR: 400,
  PROMPT_EMPTY: 400,
  PROMPT_TOO_LONG: 413,
  UNSUPPORTED_MODEL: 422,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  OPTIMISATION_REFUSED: 422,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 502,
  INVALID_MODEL_OUTPUT: 502,
  SPEND_CAP_REACHED: 503,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BILLING_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = options.details ?? {};
    this.headers = options.headers ?? {};
  }

  toEnvelope(requestId: string) {
    return {
      error: { code: this.code, message: this.message, details: this.details },
      request_id: requestId,
    };
  }
}

/** Map any thrown value to an AppError without leaking internals (§10.6). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError("VALIDATION_ERROR", "The request is invalid.", {
      details: { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return new AppError("INTERNAL_ERROR", "Something went wrong. Please try again, quoting the request ID.", { cause: error });
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found.`);
export const unauthenticated = () =>
  new AppError("UNAUTHENTICATED", "Please sign in to continue.");
export const forbidden = (message = "This feature is not available on your plan.") =>
  new AppError("FORBIDDEN", message);
