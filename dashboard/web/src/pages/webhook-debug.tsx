import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeliveryStatusBadge } from "@/components/delivery-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { api, formatDateTime, formatMoney, type DeliveryDetail, type DeliverySummary } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Page {
  deliveries: DeliverySummary[];
  nextCursor: string | null;
}

/** Every request LivePix sent to this webhook, newest first, with its headers, body and outcome. */
export function DebugPanel({ webhookId }: { webhookId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const deliveries = useInfiniteQuery({
    queryKey: ["deliveries", webhookId],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page>(`/webhooks/${webhookId}/deliveries?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
  const rows = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const current = selected ?? rows[0]?.id ?? null;

  if (deliveries.isPending) return <p className="py-6 text-sm text-muted-foreground">Carregando notificações…</p>;
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Inbox className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Nenhuma notificação recebida</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Assim que o LivePix chamar a URL deste webhook, cada chamada aparece aqui com cabeçalhos e corpo. A lista
            atualiza sozinha a cada 5 segundos.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card className="py-0">
        <ScrollArea className="h-[560px]">
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelected(row.id)}
                  className={cn(
                    "grid w-full gap-1 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                    row.id === current && "bg-accent",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{formatDateTime(row.receivedAt)}</span>
                    <DeliveryStatusBadge status={row.status} />
                  </div>
                  <div className="truncate text-sm">
                    {row.donation
                      ? `${formatMoney(row.donation.amount, row.donation.currency)}${row.donation.username ? ` de ${row.donation.username}` : ""}`
                      : `${row.event ?? "sem evento"} · ${row.resourceType ?? "sem recurso"}`}
                  </div>
                  {row.lastError && <div className="truncate text-xs text-muted-foreground">{row.lastError}</div>}
                </button>
              </li>
            ))}
          </ul>
          {deliveries.hasNextPage && (
            <div className="p-3">
              <Button variant="outline" className="w-full" disabled={deliveries.isFetchingNextPage} onClick={() => deliveries.fetchNextPage()}>
                {deliveries.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />}
                Carregar mais
              </Button>
            </div>
          )}
        </ScrollArea>
      </Card>
      {current && <DeliveryDetailCard webhookId={webhookId} deliveryId={current} />}
    </div>
  );
}

function DeliveryDetailCard({ webhookId, deliveryId }: { webhookId: string; deliveryId: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["delivery", webhookId, deliveryId],
    queryFn: () => api<{ delivery: DeliveryDetail }>(`/webhooks/${webhookId}/deliveries/${deliveryId}`).then((r) => r.delivery),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2_000 : false),
  });
  const reprocess = useMutation({
    mutationFn: () =>
      api<{ status: string; lastError: string | null }>(`/webhooks/${webhookId}/deliveries/${deliveryId}/reprocess`, { method: "POST" }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["delivery", webhookId, deliveryId] });
      void queryClient.invalidateQueries({ queryKey: ["deliveries", webhookId] });
      void queryClient.invalidateQueries({ queryKey: ["webhook", webhookId] });
      if (result.status === "processed" || result.status === "duplicate") toast.success("Notificação processada.");
      else toast.error(result.lastError ?? "A notificação continua sem virar doação.");
    },
    onError: () => toast.error("Esta notificação não pode ser reprocessada agora."),
  });

  if (detail.isPending) return <Card className="h-[560px]" />;
  if (detail.isError || !detail.data) return <p className="text-sm text-destructive">Não foi possível abrir a notificação.</p>;
  const d = detail.data;
  const canReprocess = d.status === "failed" || d.status === "ignored";

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle className="font-mono text-sm">
            {d.method} {d.path}
            {d.query}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Recebida em {formatDateTime(d.receivedAt)}
            {d.remoteIp ? ` de ${d.remoteIp}` : ""} · {d.attempts} tentativa(s)
            {d.nextAttemptAt ? ` · próxima em ${formatDateTime(d.nextAttemptAt)}` : ""}
          </p>
        </div>
        <DeliveryStatusBadge status={d.status} />
      </CardHeader>
      <CardContent className="grid gap-5">
        {d.lastError && (
          <Alert variant={d.status === "failed" ? "destructive" : "default"}>
            <AlertDescription>{d.lastError}</AlertDescription>
          </Alert>
        )}
        {canReprocess && (
          <Button variant="outline" className="w-fit" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}>
            {reprocess.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
            Processar de novo
          </Button>
        )}
        {d.donation && (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Doação</h3>
            <KeyValues
              entries={[
                ["Valor", formatMoney(d.donation.amount, d.donation.currency)],
                ["Apoiador", d.donation.username],
                ["Mensagem", d.donation.message],
                ["Aconteceu em", formatDateTime(d.donation.occurredAt)],
                ["ID entregue ao plugin", d.donation.id],
              ]}
            />
          </section>
        )}
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Corpo</h3>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{prettyJson(d.body)}</pre>
        </section>
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Cabeçalhos</h3>
          <KeyValues entries={Object.entries(d.headers)} mono />
        </section>
      </CardContent>
    </Card>
  );
}

function KeyValues({ entries, mono = false }: { entries: Array<[string, string]>; mono?: boolean }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableBody>
          {entries.map(([key, value]) => (
            <TableRow key={key}>
              <TableCell className="w-1/3 align-top text-xs text-muted-foreground">{key}</TableCell>
              <TableCell className={cn("text-xs break-all whitespace-normal", mono && "font-mono")}>{value || "–"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function prettyJson(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body || "(vazio)";
  }
}
