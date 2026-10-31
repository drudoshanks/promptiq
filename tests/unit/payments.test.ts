import { describe, expect, it } from "vitest";

import { MAX_SCREENSHOT_BYTES, sniffImageType, validateScreenshot } from "@/lib/payments/screenshot";
import {
  addMonthsUtc,
  buildUpiUri,
  canTransition,
  formatInr,
  generatePaymentReference,
  normaliseTransactionReference,
  parseInrToMinor,
  PAYMENT_REFERENCE_PATTERN,
  upiAmount,
  validateTransactionReference,
} from "@/lib/payments/upi";
import { renderNotification } from "@/lib/services/notifications";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);

describe("money in paise", () => {
  it("formats rupees and the UPI amount exactly", () => {
    expect(upiAmount(49900)).toBe("499.00");
    expect(upiAmount(499005)).toBe("4990.05");
    expect(upiAmount(1)).toBe("0.01");
    expect(() => upiAmount(0)).toThrow();
    expect(() => upiAmount(10.5)).toThrow();
    expect(formatInr(499000)).toBe("₹4,990.00");
  });

  it("parses user amounts without floating-point drift", () => {
    expect(parseInrToMinor("499")).toBe(49900);
    expect(parseInrToMinor("499.5")).toBe(49950);
    expect(parseInrToMinor("₹ 4,990.00")).toBe(499000);
    expect(parseInrToMinor("0.1")).toBe(10);
    expect(parseInrToMinor("abc")).toBeNull();
    expect(parseInrToMinor("1.999")).toBeNull();
    expect(parseInrToMinor("-5")).toBeNull();
  });
});

describe("UPI URI", () => {
  it("builds a standard, correctly encoded upi://pay link", () => {
    const uri = buildUpiUri({ vpa: "PromptIQ.Pay@OKAXIS", payeeName: "Prompt IQ & Co", amountMinor: 49900, reference: "PIQ-2026-7KQ3M" });
    expect(uri).toBe("upi://pay?pa=promptiq.pay%40okaxis&pn=Prompt%20IQ%20%26%20Co&am=499.00&cu=INR&tn=PIQ-2026-7KQ3M");
    const params = new URLSearchParams(uri.split("?")[1]);
    expect(params.get("pn")).toBe("Prompt IQ & Co");
    expect(params.get("am")).toBe("499.00");
  });

  it("refuses invalid payees and references", () => {
    expect(() => buildUpiUri({ vpa: "not-a-vpa", payeeName: "PromptIQ", amountMinor: 100, reference: "PIQ-2026-7KQ3M" })).toThrow(/UPI ID/);
    expect(() => buildUpiUri({ vpa: "a@b&pa=evil@x", payeeName: "PromptIQ", amountMinor: 100, reference: "PIQ-2026-7KQ3M" })).toThrow();
    expect(() => buildUpiUri({ vpa: "pay@okaxis", payeeName: "<script>", amountMinor: 100, reference: "PIQ-2026-7KQ3M" })).toThrow(/payee/);
    expect(() => buildUpiUri({ vpa: "pay@okaxis", payeeName: "PromptIQ", amountMinor: 100, reference: "x&am=1" })).toThrow(/reference/);
  });
});

describe("references", () => {
  it("generates human-readable payment references without look-alike characters", () => {
    for (let i = 0; i < 200; i++) {
      const r = generatePaymentReference(new Date("2026-10-31T00:00:00Z"));
      expect(r).toMatch(PAYMENT_REFERENCE_PATTERN);
      expect(r.startsWith("PIQ-2026-")).toBe(true);
      expect(r.slice(9)).not.toMatch(/[01ILOU]/);
    }
  });

  it("accepts varied UPI transaction references and normalises them for duplicate checks", () => {
    expect(validateTransactionReference("4309 1234 5678")).toMatchObject({ ok: true, normalized: "430912345678" });
    expect(validateTransactionReference("T2410311530123456789")).toMatchObject({ ok: true });
    expect(validateTransactionReference("axis/ref-99AB12")).toMatchObject({ ok: true, normalized: "AXISREF99AB12" });
    expect(normaliseTransactionReference("4309-1234-5678")).toBe(normaliseTransactionReference("430912345678"));
    for (const bad of ["12345", "a".repeat(41), "000000000000", "1234567890", "DROP TABLE;--", "12 34 5"]) {
      expect(validateTransactionReference(bad).ok, bad).toBe(false);
    }
  });
});

describe("payment state machine", () => {
  it("only an administrator can verify, and only eligible states", () => {
    expect(canTransition("SUBMITTED_FOR_VERIFICATION", "VERIFIED", "admin")).toBe(true);
    expect(canTransition("UNDER_REVIEW", "VERIFIED", "admin")).toBe(true);
    expect(canTransition("SUBMITTED_FOR_VERIFICATION", "VERIFIED", "user")).toBe(false);
    expect(canTransition("PENDING_PAYMENT", "VERIFIED", "admin")).toBe(false);
    expect(canTransition("REJECTED", "VERIFIED", "admin")).toBe(false);
    expect(canTransition("VERIFIED", "REJECTED", "admin")).toBe(false);
    expect(canTransition("PENDING_PAYMENT", "EXPIRED", "system")).toBe(true);
    expect(canTransition("SUBMITTED_FOR_VERIFICATION", "CANCELLED", "user")).toBe(false);
    // Expired/cancelled may be verified only through the admin recovery path.
    expect(canTransition("EXPIRED", "VERIFIED", "admin")).toBe(true);
    expect(canTransition("EXPIRED", "VERIFIED", "user")).toBe(false);
  });

  it("adds billing periods by calendar month, clamping month ends", () => {
    expect(addMonthsUtc(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2028-01-31T10:00:00Z"), 1).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonthsUtc(new Date("2026-10-31T00:00:00Z"), 12).toISOString()).toBe("2027-10-31T00:00:00.000Z");
  });
});

describe("screenshot validation by content", () => {
  it("accepts PNG, JPEG and WebP by magic bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("rejects disguised, empty and oversized files", () => {
    expect(validateScreenshot(Buffer.from("<svg onload=alert(1)>"))).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(validateScreenshot(Buffer.from("%PDF-1.7"))).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(validateScreenshot(new Uint8Array())).toMatchObject({ ok: false });
    const big = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    big.set(PNG);
    expect(validateScreenshot(big)).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("notification templates", () => {
  it("never ask for PINs and carry the reference", () => {
    const created = renderNotification("payment_request_created", { reference: "PIQ-2026-7KQ3M", amount: "₹499.00", plan: "Pro", payee_name: "PromptIQ", payee_vpa: "pay@okaxis", expires_at: "x" }, "https://app");
    expect(created.subject).toContain("PIQ-2026-7KQ3M");
    expect(created.text).toMatch(/never ask for your UPI PIN/);
    expect(renderNotification("payment_rejected", { reference: "R", reason: "No credit found" }, "https://app").text).toContain("No credit found");
  });
});
