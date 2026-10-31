"use client";

import {
  BarChart3,
  Gauge,
  History,
  Home,
  Library,
  Lightbulb,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { authClient } from "@/lib/auth/client";
import { cx } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Work",
    items: [
      { href: "/app", label: "Overview", icon: Home, exact: true },
      { href: "/app/intelligence", label: "Prompt intelligence", icon: Sparkles },
      { href: "/app/studio", label: "Quick studio", icon: SquarePen },
      { href: "/app/library", label: "My prompts", icon: Library },
      { href: "/app/suggestions", label: "Suggestions", icon: Lightbulb },
    ],
  },
  {
    label: "Insight",
    items: [
      { href: "/app/history", label: "History", icon: History },
      { href: "/app/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/app/usage", label: "Usage and plan", icon: Gauge },
    ],
  },
  {
    label: "You",
    items: [
      { href: "/app/preferences", label: "Preferences", icon: SlidersHorizontal },
      { href: "/app/settings", label: "Settings", icon: Settings },
    ],
  },
];

interface AppNavProps {
  email: string | null;
  isAdmin: boolean;
}

function NavLinks({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const groups = isAdmin ? [...GROUPS, { label: "Operator", items: [{ href: "/admin", label: "Operations", icon: ShieldCheck }] }] : GROUPS;
  return (
    <nav aria-label="Application" className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-3 text-[0.8125rem] font-medium text-ink-faint">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const current = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link href={item.href} className="nav-link" aria-current={current ? "page" : undefined} onClick={onNavigate}>
                    <Icon aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/app" className="flex items-center gap-2 text-[1.0625rem] font-semibold tracking-tight no-underline">
      <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-[7px] bg-accent font-mono text-[0.8125rem] font-semibold text-white">
        iq
      </span>
      PromptIQ
    </Link>
  );
}

/** Application shell: a grouped sidebar on wide screens, a top bar with a drawer on small ones. */
export function AppNav({ email, isAdmin }: AppNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const signOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    router.push("/");
    router.refresh();
  };

  const account = (
    <div className="border-t border-line pt-4">
      {email ? (
        <p className="truncate px-3 text-sm text-ink-soft" title={email}>
          {email}
        </p>
      ) : null}
      <button type="button" className="nav-link mt-1 w-full" disabled={signingOut} onClick={signOut}>
        <LogOut aria-hidden="true" />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );

  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-64 flex-none flex-col gap-6 overflow-y-auto border-r border-line bg-panel px-4 py-5 lg:flex">
        <div className="px-2">
          <Brand />
        </div>
        <div className="flex-1">
          <NavLinks isAdmin={isAdmin} />
        </div>
        {account}
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-panel/95 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(true)}>
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Open menu</span>
        </button>
      </header>

      <div
        className={cx("fixed inset-0 z-40 bg-ink/40 transition-opacity lg:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")}
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        id="mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={cx("fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col gap-6 overflow-y-auto bg-panel px-4 py-5 shadow-xl transition-transform lg:hidden", open ? "translate-x-0" : "-translate-x-full")}
        key={pathname}
      >
        <div className="flex items-center justify-between px-2">
          <Brand />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
            <X className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">Close menu</span>
          </button>
        </div>
        <div className="flex-1">
          <NavLinks isAdmin={isAdmin} onNavigate={() => setOpen(false)} />
        </div>
        {account}
      </div>
    </>
  );
}
