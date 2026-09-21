import { Badge } from "@/components/ui/badge";
import type { DeliveryStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const LABELS: Record<DeliveryStatus, { label: string; tone: string }> = {
  pending: { label: "Pendente", tone: "bg-warning/15 text-warning border-warning/30" },
  processed: { label: "Doação registrada", tone: "bg-success/15 text-success border-success/30" },
  duplicate: { label: "Mesma doação", tone: "bg-muted text-muted-foreground border-border" },
  ignored: { label: "Ignorada", tone: "bg-muted text-muted-foreground border-border" },
  failed: { label: "Falhou", tone: "bg-destructive/15 text-destructive border-destructive/30" },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const entry = LABELS[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", entry.tone)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {entry.label}
    </Badge>
  );
}
