import "server-only";

import { env, features } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transactional email (password recovery, account notices).
 * Uses the Resend HTTP API when RESEND_API_KEY is set. In development without a
 * key the message is printed to the server log so the flow can be exercised.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!features.email) {
    if (env.NODE_ENV === "production") {
      logger.warn("email not configured; message dropped", {
        subject: message.subject,
      });
      return;
    }
    // Development convenience only: never log message bodies in production.
    console.log(
      `\n[email:dev] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`,
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    logger.error("email send failed", { status: response.status, subject: message.subject });
    throw new Error("Email delivery failed");
  }
}
