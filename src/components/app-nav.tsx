"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import { cx } from "@/lib/utils";

const LINKS = [
  { href: "/app", label: "Overview", exact: true },
  { href: "/app/studio", label: "Studio" },
  { href: "/app/library", label: "My prompts" },
  { href: "/app/suggestions", label: "Suggestions" },
  { href: "/app/history", label: "History" },
  { href: "/app/analytics", label: "Analytics" },
  { href: "/app/preferences", label: "Preferences" },
  { href: "/app/usage", label: "Usage" },
  { href: "/app/settings", label: "Settings" },
];

interface AppNavProps {
  email: string | null;
  isAdmin: boolean;
}

export function AppNav({ email, isAdmin }: AppNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const links = isAdmin ? [...LINKS, { href: "/admin", label: "Operations" }] : LINKS;

  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/app" className="text-lg font-semibold tracking-tight no-underline">
          PromptIQ
        </Link>
        <nav aria-label="Application" className="order-last flex w-full flex-wrap gap-1 md:order-none md:w-auto md:flex-1">
          {links.map((link) => {
            const current = link.exact ? pathname === link.href : pathname.startsWith(link.href);
            return (
              <Link key={link.href} href={link.href} className="nav-link" aria-current={current ? "page" : undefined}>
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-ink-soft">
          {email ? <span className="hidden sm:inline">{email}</span> : null}
          <button
            type="button"
            className={cx("btn btn-ghost btn-sm")}
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await authClient.signOut();
              router.push("/");
              router.refresh();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
