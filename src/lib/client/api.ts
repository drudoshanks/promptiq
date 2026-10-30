"use client";

/**
 * Browser-side client for /api/v1 (envelope conventions of SRS §10.1).
 * Throws ApiError with the server's code so screens can branch on it.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("NETWORK_ERROR", "Could not reach PromptIQ. Check your connection and try again.", 0);
  }

  const requestId = response.headers.get("x-request-id");
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: { data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } } = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) throw new ApiError("INTERNAL_ERROR", "Unexpected response from the server.", response.status, {}, requestId);
  }

  if (!response.ok) {
    const err = payload.error ?? { code: "INTERNAL_ERROR", message: "Something went wrong." };
    throw new ApiError(err.code, err.message, response.status, err.details ?? {}, requestId);
  }
  return payload.data as T;
}

/** Download a raw (non-JSON) endpoint as a file, e.g. exports. */
export async function downloadFromApi(path: string, options: { method?: "GET" | "POST" } = {}): Promise<void> {
  const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin" });
  if (!response.ok) {
    let message = "Download failed.";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // ignore
    }
    throw new ApiError("DOWNLOAD_FAILED", message, response.status);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const blob = await response.blob();
  triggerDownload(blob, match?.[1] ?? "download");
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
