import type { ReactNode } from "react";

import { cx } from "@/lib/utils";

type Tone = "info" | "success" | "warning" | "error";

const TONES: Record<Tone, string> = {
  info: "bg-info-soft text-info-ink",
  success: "bg-accent-soft text-accent-deep",
  warning: "bg-estimate-soft text-estimate",
  error: "bg-danger-soft text-danger",
};

interface AlertProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}

export function Alert({ tone = "info", title, children, className, action }: AlertProps) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-[var(--radius-control)] px-4 py-3 text-[0.9375rem]", TONES[tone], className)}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={cx(title && "mt-1")}>{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
