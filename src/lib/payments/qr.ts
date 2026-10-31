import "server-only";

import QRCode from "qrcode";

/** Render a UPI URI as an SVG QR code locally (no external service sees payment details). */
export async function upiQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 280, color: { dark: "#12201c", light: "#ffffff" } });
}
