/**
 * Screenshot validation by content, not by the client's file name or MIME
 * type. Only PNG, JPEG and WebP are accepted, up to 2 MB.
 */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export type ScreenshotType = "image/png" | "image/jpeg" | "image/webp";

export function sniffImageType(bytes: Uint8Array): ScreenshotType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function validateScreenshot(bytes: Uint8Array): { ok: true; type: ScreenshotType } | { ok: false; code: "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE"; reason: string } {
  if (bytes.length === 0) return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", reason: "The screenshot file is empty." };
  if (bytes.length > MAX_SCREENSHOT_BYTES) return { ok: false, code: "PAYLOAD_TOO_LARGE", reason: "Screenshots can be up to 2 MB." };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", reason: "Upload a PNG, JPEG or WebP image." };
  return { ok: true, type };
}
