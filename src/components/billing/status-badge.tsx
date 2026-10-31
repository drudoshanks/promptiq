import { Badge } from "@/components/ui/badge";
import type { PaymentStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/payments/upi";

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const s = STATUS_LABELS[status];
  return (
    <Badge tone={s.tone} title={s.help}>
      {s.label}
    </Badge>
  );
}
