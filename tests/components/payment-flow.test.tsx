// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentFlow, type PaymentView } from "@/components/billing/payment-flow";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const base: PaymentView = {
  id: "11111111-1111-4111-8111-111111111111",
  payment_reference: "PIQ-2026-7KQ3M",
  plan: { name: "Pro — monthly" },
  expected_amount_minor: 49900,
  expected_amount_display: "₹499.00",
  payee_vpa: "promptiq@okaxis",
  payee_name: "PromptIQ",
  status: "PENDING_PAYMENT",
  amount_mismatch: false,
  info_requested: false,
  info_request_message: null,
  rejection_reason: null,
  expires_at: "2026-11-02T10:00:00.000Z",
  submitted_at: null,
  verified_at: null,
  verified_amount_minor: null,
  upi_uri: "upi://pay?pa=promptiq%40okaxis&pn=PromptIQ&am=499.00&cu=INR&tn=PIQ-2026-7KQ3M",
  submissions: [],
};
let sent: FormData | null = null;
const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  sent = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = init.body as FormData;
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UPI payment page", () => {
  it("shows the exact amount, payee, reference, QR and a deep link, with copy buttons", async () => {
    render(<PaymentFlow payment={base} qrSvg={'<svg data-testid="qr"></svg>'} subscriptionEnds={null} />);
    expect(screen.getByText("₹499.00")).toBeTruthy();
    expect(screen.getByText("promptiq@okaxis")).toBeTruthy();
    expect(screen.getByText("PIQ-2026-7KQ3M")).toBeTruthy();
    expect(screen.getByRole("img", { name: /UPI QR code to pay ₹499.00 to PromptIQ/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open in a UPI app/ }).getAttribute("href")).toBe(base.upi_uri);
    expect(screen.getByText(/not instantly/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy UPI ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("promptiq@okaxis"));
  });

  it("submits the transaction details as multipart form data and flags a different amount", async () => {
    render(<PaymentFlow payment={base} qrSvg={null} subscriptionEnds={null} />);
    fireEvent.click(screen.getByRole("button", { name: "I have paid" }));
    const submit = screen.getByRole("button", { name: "Submit payment details" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/UPI transaction ID/), { target: { value: "430912345678" } });
    fireEvent.change(screen.getByLabelText("Amount paid (₹)"), { target: { value: "490.00" } });
    expect(screen.getByText(/Different from the amount due/)).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent!.get("transaction_reference")).toBe("430912345678");
    expect(sent!.get("amount")).toBe("490.00");
    expect(String(sent!.get("paid_at"))).toMatch(/Z$/);
  });

  it("shows status, rejection reasons and the information request", () => {
    const { rerender } = render(<PaymentFlow payment={{ ...base, status: "SUBMITTED_FOR_VERIFICATION", upi_uri: null }} qrSvg={null} subscriptionEnds={null} />);
    expect(screen.getByText("Payment details submitted. Your subscription will be activated after verification.")).toBeTruthy();
    rerender(<PaymentFlow payment={{ ...base, status: "REJECTED", upi_uri: null, rejection_reason: "No matching credit found." }} qrSvg={null} subscriptionEnds={null} />);
    expect(screen.getByText("No matching credit found.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retry payment" })).toBeTruthy();
    cleanup();
    render(<PaymentFlow payment={{ ...base, status: "UNDER_REVIEW", upi_uri: null, info_requested: true, info_request_message: "Please upload a screenshot." }} qrSvg={null} subscriptionEnds={null} />);
    expect(screen.getByText("Please upload a screenshot.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit payment details" })).toBeTruthy();
  });
});
