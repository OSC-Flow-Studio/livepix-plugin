import { useInfiniteQuery } from "@tanstack/react-query";
import { HandCoins, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, formatDateTime, formatMoney, type Donation } from "@/lib/api";

interface Page {
  donations: Array<Donation & { rowId: string }>;
  nextCursor: string | null;
}

/** What the plugin receives: one row per donation, however many notifications LivePix sent for it. */
export function DonationsPanel({ webhookId }: { webhookId: string }) {
  const donations = useInfiniteQuery({
    queryKey: ["donations", webhookId],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<Page>(`/webhooks/${webhookId}/donations?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const rows = donations.data?.pages.flatMap((page) => page.donations) ?? [];

  if (donations.isPending) return <p className="py-6 text-sm text-muted-foreground">Carregando doações…</p>;
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <HandCoins className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Nenhuma doação registrada</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Uma notificação vira doação depois que o dashboard confirma valor, nome e mensagem na API do LivePix.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quando</TableHead>
            <TableHead>Valor</TableHead>
            <TableHead>Apoiador</TableHead>
            <TableHead className="w-1/2">Mensagem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.rowId}>
              <TableCell className="font-mono text-xs text-muted-foreground">{formatDateTime(row.occurredAt)}</TableCell>
              <TableCell className="font-medium tabular-nums">{formatMoney(row.amount, row.currency)}</TableCell>
              <TableCell>{row.username || <span className="text-muted-foreground">Anônimo</span>}</TableCell>
              <TableCell className="whitespace-normal">
                {row.message || <span className="text-muted-foreground">Sem mensagem</span>}
                {row.flagged && <span className="ml-2 text-xs text-warning">marcada pela moderação</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {donations.hasNextPage && (
        <div className="border-t p-3">
          <Button variant="outline" className="w-full" disabled={donations.isFetchingNextPage} onClick={() => donations.fetchNextPage()}>
            {donations.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />}
            Carregar mais
          </Button>
        </div>
      )}
    </Card>
  );
}
