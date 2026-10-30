import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <Link href="/" className="text-lg font-semibold tracking-tight no-underline">
          PromptIQ
        </Link>
      </header>
      <main className="mx-auto max-w-md px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
