import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/app");

  return (
    <div className="min-h-dvh">
      <AppNav email={user.email} isAdmin={user.isAdmin} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
