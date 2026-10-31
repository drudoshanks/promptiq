import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppNav } from "@/components/app-nav";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Operator area: same shell as the app; every page and API also checks admin rights on the server. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=/admin");
  if (!user.isAdmin) redirect("/app");
  return (
    <div className="min-h-dvh lg:flex">
      <AppNav email={user.email} isAdmin />
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</div>
      </main>
    </div>
  );
}
