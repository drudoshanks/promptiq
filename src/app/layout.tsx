import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PromptIQ by iMarwar",
    template: "%s · PromptIQ by iMarwar",
  },
  description: "PromptIQ by iMarwar turns rough requests into AI-ready prompts: analyse, optimise or break them into steps, with every requirement checked and token costs shown.",
  applicationName: "PromptIQ",
  authors: [{ name: "iMarwar", url: "https://imarwar.com/" }],
  creator: "iMarwar",
  publisher: "iMarwar",
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
