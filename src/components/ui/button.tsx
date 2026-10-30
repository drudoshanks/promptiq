import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "@/lib/utils";

import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading = false, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={rest.type ?? "button"}
      className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

interface LinkButtonProps {
  href: string;
  variant?: Variant;
  size?: "md" | "sm";
  className?: string;
  children: ReactNode;
}

export function LinkButton({ href, variant = "secondary", size = "md", className, children }: LinkButtonProps) {
  return (
    <Link href={href} className={cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}>
      {children}
    </Link>
  );
}
