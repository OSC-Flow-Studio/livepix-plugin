import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { HandCoins, Loader2, RotateCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, formatDateTime, formatMoney, type Donation } from "@/lib/api";
import { donationRecoveryCopy } from "./donation-recovery-copy";

type Row = Donation & { rowId: string; accountedAt: string | null; lastResentAt: string | null; resendCount: number };
interface Page { donations: Row[]; nextCursor: string | null }
interface ImportPage { imported: number; existing: number; invalid: number; fetched: number; hasMore: boolean }

export function DonationsPanel({ webhookId }: { webhookId: string }) {
  const copy = donationRecoveryCopy();
  const queryClient = useQueryClient();
  const [since, setSince] = useState("");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const [dateError, setDateError] = useState(false);
  const [progress, setProgress] = useState("");
  const [importError, setImportError] = useState("");
  const stop = useRef(false);
  const cursor = useRef<{ since: string; resource: number; page: number; imported: number; existing: number; invalid: number } | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, [webhookId]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["donations", webhookId] });
  const sinceIso = since && Number.isFinite(Date.parse(since)) ? new Date(since).toISOString() : "";
  const donations = useInfiniteQuery({
    queryKey: ["donations", webhookId, sinceIso, query], initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (pageParam) params.set("cursor", pageParam);
      if (sinceIso) params.set("since", sinceIso);
      if (query) params.set("search", query);
      return api<Page>(`/webhooks/${webhookId}/donations?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined, refetchInterval: 10_000,
  });
  const rows = donations.data?.pages.flatMap((page) => page.donations) ?? [];
  const sendError = (error: Error) => toast.error(error instanceof ApiError && error.code === "plugin_offline" ? copy.offline
    : error instanceof ApiError && error.code === "webhook_inactive" ? copy.inactive : copy.sendFailed);
  const resend = useMutation({
    mutationFn: (rowId: string) => api(`/webhooks/${webhookId}/donations/${rowId}/resend`, { method: "POST" }),
    onSuccess: () => { toast.success(copy.sent); void refresh(); }, onError: sendError,
  });
  const recover = useMutation({
    mutationFn: () => api(`/webhooks/${webhookId}/donations/recover`, { method: "POST" }),
    onSuccess: () => toast.success(copy.recoverySent), onError: sendError,
  });
  const history = useMutation({
    mutationFn: async (start: string) => {
      stop.current = false; setImportError(""); setPaused(false);
      if (!cursor.current || cursor.current.since !== start) cursor.current = { since: start, resource: 0, page: 1, imported: 0, existing: 0, invalid: 0 };
      const current = cursor.current;
      const report = (label: string) => `${label}. ${copy.imported}: ${current.imported}. ${copy.existing}: ${current.existing}.${current.invalid ? ` ${copy.invalid}: ${current.invalid}.` : ""}`;
      setProgress(copy.importing);
      while (current.resource < 2 && !stop.current) {
          const resource = ["messages", "payments"][current.resource];
          const result = await api<ImportPage>(`/webhooks/${webhookId}/donations/import`, { method: "POST", body: { since: start, resource, page: current.page } });
          current.imported += result.imported; current.existing += result.existing; current.invalid += result.invalid;
          setProgress(report(copy.importing));
          void refresh();
          if (!result.hasMore) { current.resource++; current.page = 1; }
          else current.page++;
      }
      setProgress(report(stop.current ? copy.stopped : copy.complete));
      setPaused(current.resource < 2);
      if (current.resource === 2) cursor.current = null;
    },
    onError: () => { setPaused(true); setProgress((text) => text.replace(copy.importing, copy.stopped)); setImportError(copy.importFailed); void refresh(); },
  });
  function importHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sinceIso) { setDateError(true); return; }
    setDateError(false); history.mutate(sinceIso);
  }

  return (
    <div className="grid min-w-0 gap-4">
      <Card>
        <CardContent className="grid gap-4">
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={importHistory}>
            <div className="grid min-w-0 flex-1 gap-2 sm:min-w-56">
              <Label htmlFor="donations-since">{copy.since}</Label>
              <Input id="donations-since" type="datetime-local" className="dark:[color-scheme:dark]" value={since} disabled={history.isPending} aria-invalid={dateError}
                aria-describedby={dateError ? "donations-date-error" : undefined} onChange={(e) => { setSince(e.target.value); setDateError(false); setPaused(false); }} />
            </div>
            <Button type="submit" disabled={history.isPending}>
              {history.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}{paused ? copy.retry : copy.import}
            </Button>
            {history.isPending && <Button type="button" variant="outline" onClick={() => { stop.current = true; }}>{copy.stop}</Button>}
          </form>
          {dateError && <p id="donations-date-error" role="alert" className="text-sm text-destructive">{copy.dateRequired}</p>}
          {progress && <p role="status" className="text-sm text-muted-foreground">{progress}</p>}
          {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid min-w-0 flex-1 gap-2 sm:min-w-56">
              <Label htmlFor="donations-search">{copy.search}</Label>
              <Input id="donations-search" placeholder={copy.placeholder} value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Button variant="outline" disabled={recover.isPending || history.isPending} onClick={() => recover.mutate()}>
              {recover.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}{copy.recover}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{copy.help}</p>
          <p className="text-xs text-muted-foreground">{copy.receipt}</p>
        </CardContent>
      </Card>
      {donations.isError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        {copy.failed}<Button variant="outline" disabled={donations.isFetching} onClick={() => donations.refetch()}>{copy.retry}</Button>
      </div>}
      {donations.isPending ? <p className="py-6 text-sm text-muted-foreground">{copy.loading}</p> : rows.length === 0 && !donations.isError ? (
        <Card><CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <HandCoins className="size-8 text-muted-foreground" aria-hidden /><p className="font-medium">{copy.empty}</p>
        </CardContent></Card>
      ) : rows.length > 0 && (
        <Card className="min-w-0 py-0">
          <Table><TableHeader><TableRow>
            {[copy.when, copy.amount, copy.supporter, copy.message, copy.accounting, copy.resend].map((label) => <TableHead key={label}>{label}</TableHead>)}
          </TableRow></TableHeader><TableBody>
            {rows.map((row) => <TableRow key={row.rowId}>
              <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.occurredAt)}<span className="mt-1 block max-w-44 truncate font-mono" title={row.id}>{row.id}</span></TableCell>
              <TableCell className="font-medium tabular-nums">{formatMoney(row.amount, row.currency)}</TableCell>
              <TableCell className="max-w-40 truncate" title={row.username}>{row.username || copy.anonymous}</TableCell>
              <TableCell className="min-w-40 max-w-72 whitespace-normal break-words">{row.message || copy.noMessage}{row.flagged && <p className="text-xs text-warning">{copy.flagged}</p>}</TableCell>
              <TableCell><Badge variant={row.accountedAt ? "secondary" : "outline"}>{row.accountedAt ? copy.confirmed : copy.unconfirmed}</Badge>
                {row.accountedAt && <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(row.accountedAt)}</p>}
              </TableCell>
              <TableCell><Button variant="outline" size="sm" disabled={resend.isPending || history.isPending} onClick={() => resend.mutate(row.rowId)}>
                {resend.isPending && resend.variables === row.rowId ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}{copy.resend}
              </Button>{row.lastResentAt && <p className="mt-1 text-xs text-muted-foreground" title={`${copy.resent}: ${formatDateTime(row.lastResentAt)}`}>{formatDateTime(row.lastResentAt)}</p>}</TableCell>
            </TableRow>)}
          </TableBody></Table>
          {donations.hasNextPage && <CardFooter className="border-t py-3"><Button variant="outline" className="w-full" disabled={donations.isFetchingNextPage} onClick={() => donations.fetchNextPage()}>
            {donations.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />}{copy.more}
          </Button></CardFooter>}
        </Card>
      )}
    </div>
  );
}
