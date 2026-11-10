import Image from "next/image";
import Link from "next/link";

import { cx } from "@/lib/utils";

/** iMarwar company details, as published on imarwar.com. */
export const IMARWAR = {
  name: "iMarwar",
  url: "https://imarwar.com/",
  tagline: "IT solutions for a smarter tomorrow",
  email: "contact@imarwar.com",
  phone: "+91 7062656332",
  phoneHref: "tel:+917062656332",
  hours: "Mon–Sat, 10am–7pm IST",
  address: "Plot No.116, KH No.75, Sankar Nagar Scheme, Jhalamand, Jodhpur 342013, Rajasthan",
  linkedin: "https://www.linkedin.com/company/imarwar",
} as const;

/** The iMarwar dot mark: the product icon. */
export function BrandMark({ className, size = 32 }: { className?: string; size?: number }) {
  return <Image src="/brand/imarwar-mark.svg" alt="" width={size} height={size} unoptimized className={cx("flex-none", className)} priority />;
}

/** "PromptIQ by iMarwar" lockup. */
export function ProductLogo({ href = "/", tone = "dark", compact = false, className }: { href?: string; tone?: "dark" | "light"; compact?: boolean; className?: string }) {
  return (
    <Link href={href} className={cx("group flex items-center gap-2.5 no-underline", className)} aria-label="PromptIQ by iMarwar, home">
      <BrandMark size={compact ? 28 : 34} />
      <span className="flex flex-col leading-none">
        <span className={cx("font-extrabold tracking-[-0.03em]", compact ? "text-[1.1875rem]" : "text-[1.375rem]", tone === "dark" ? "text-ink" : "text-white")}>
          Prompt<span className="text-brand-gradient">IQ</span>
        </span>
        <span className={cx("mt-1 text-[0.625rem] font-semibold uppercase tracking-[0.16em]", tone === "dark" ? "text-ink-faint" : "text-white/60")}>by iMarwar</span>
      </span>
    </Link>
  );
}

/** The full iMarwar logo, linking to imarwar.com. */
export function ImarwarLogo({ tone = "dark", width = 132, className }: { tone?: "dark" | "light"; width?: number; className?: string }) {
  return (
    <a href={IMARWAR.url} target="_blank" rel="noopener" className={cx("inline-flex no-underline", className)} aria-label="iMarwar (opens imarwar.com)">
      <Image src={tone === "dark" ? "/brand/imarwar-logo.svg" : "/brand/imarwar-logo-white.svg"} alt="iMarwar" width={width} height={Math.round((width * 248) / 1123)} unoptimized />
    </a>
  );
}

/** Small "A product of iMarwar" credit for app and auth screens. */
export function MadeByImarwar({ className }: { className?: string }) {
  return (
    <a href={IMARWAR.url} target="_blank" rel="noopener" className={cx("inline-flex items-center gap-2 text-[0.8125rem] text-ink-faint no-underline hover:text-ink-soft", className)}>
      <span>A product of</span>
      <Image src="/brand/imarwar-logo.svg" alt="iMarwar" width={78} height={17} unoptimized />
    </a>
  );
}
