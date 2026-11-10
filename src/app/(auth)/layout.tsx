import { Check, Layers, ScanSearch, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { ImarwarLogo, MadeByImarwar, ProductLogo } from "@/components/brand";

const POINTS = [
  { icon: ScanSearch, text: "See what your prompt is missing, scored in seconds" },
  { icon: ShieldCheck, text: "Every name, number and constraint checked in the rewrite" },
  { icon: Layers, text: "Break big requests into step-by-step prompts" },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="canvas-hero flex min-h-dvh flex-col">
        <header className="px-5 py-5 sm:px-10 sm:py-7">
          <ProductLogo />
        </header>
        <main className="flex flex-1 items-start justify-center px-4 pb-10 pt-4 sm:items-center sm:px-6">
          <div className="w-full max-w-[28rem]">{children}</div>
        </main>
        <footer className="flex justify-center px-5 pb-6 sm:justify-start sm:px-10">
          <MadeByImarwar />
        </footer>
      </div>

      <aside aria-hidden="true" className="relative hidden overflow-hidden bg-ink p-4 lg:block">
        <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-[32px] bg-gradient-to-br from-[#1b1b20] via-[#141418] to-[#0c0c0e] p-12">
          <div className="absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-brand/30 blur-3xl" />
          <div className="absolute -bottom-40 -left-24 h-[24rem] w-[24rem] rounded-full bg-brand/10 blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:56px_56px]" />

          <div className="relative">
            <span className="announce border-white/10 bg-white/5 text-white shadow-none">
              <span className="announce-tag bg-white text-ink">New</span>
              Break down big prompts
            </span>
            <p className="mt-10 max-w-lg text-[2.75rem] font-extrabold leading-[1.05] tracking-[-0.04em] text-white">
              Prompts that get it right <span className="text-brand-gradient">the first time.</span>
            </p>
            <ul className="mt-10 space-y-4">
              {POINTS.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-3.5 text-[1.0625rem] text-white/80">
                  <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-white/[0.07] text-brand-light ring-1 ring-white/10">
                    <Icon className="h-5 w-5" />
                  </span>
                  {text}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mt-12 rounded-[22px] border border-white/10 bg-white/[0.05] p-5 backdrop-blur">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">Requirement check</p>
              <span className="rounded-full bg-brand/20 px-2.5 py-0.5 text-xs font-bold text-brand-light">5 of 5 kept</span>
            </div>
            <ul className="mt-3 space-y-2 text-sm text-white/70">
              {["Invoice 4471 for $2,300", "Due date: 12 Sept", "Polite but firm, under 120 words"].map((t) => (
                <li key={t} className="flex items-center gap-2.5">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
                    <Check className="h-3 w-3" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mt-10 flex items-center justify-between gap-4 border-t border-white/10 pt-6">
            <p className="text-sm text-white/50">A product of</p>
            <ImarwarLogo tone="light" width={150} />
          </div>
        </div>
      </aside>
    </div>
  );
}
