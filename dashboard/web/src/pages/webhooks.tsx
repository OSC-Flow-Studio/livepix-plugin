import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus, Webhook } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, formatDateTime, type WebhookView } from "@/lib/api";

export function WebhooksPage() {
  const [creating, setCreating] = useState(false);
  const webhooks = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => api<{ webhooks: WebhookView[] }>("/webhooks").then((r) => r.webhooks),
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Cada webhook recebe as notificações de uma conta do LivePix e tem o próprio token para o plugin.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          Novo webhook
        </Button>
      </div>

      {webhooks.isPending && (
        <div className="grid gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {webhooks.isError && <p className="text-sm text-destructive">Não foi possível carregar os webhooks.</p>}
      {webhooks.data?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Webhook className="size-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">Nenhum webhook ainda</p>
              <p className="text-sm text-muted-foreground">Crie o primeiro para gerar a URL que vai no painel do LivePix.</p>
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Criar webhook
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3">
        {webhooks.data?.map((webhook) => (
          <Link key={webhook.id} to={`/webhooks/${webhook.id}`} className="group">
            <Card className="py-4 transition-colors group-hover:border-primary/40">
              <CardContent className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{webhook.name}</span>
                    <Badge variant="outline" className={webhook.active ? "border-success/30 text-success" : "text-muted-foreground"}>
                      {webhook.active ? "Ativo" : "Inativo"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {webhook.stats.donations} doações · {webhook.stats.deliveries} notificações
                    {webhook.stats.lastDeliveryAt ? ` · última em ${formatDateTime(webhook.stats.lastDeliveryAt)}` : ""}
                    {webhook.token ? "" : " · sem token do plugin"}
                  </p>
                </div>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <CreateWebhookDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function CreateWebhookDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [active, setActive] = useState(true);
  const create = useMutation({
    mutationFn: (body: { name: string; active: boolean }) =>
      api<{ webhook: WebhookView }>("/webhooks", { method: "POST", body }).then((r) => r.webhook),
    onSuccess: (webhook) => {
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      onOpenChange(false);
      navigate(`/webhooks/${webhook.id}`);
    },
    onError: () => toast.error("Não foi possível criar o webhook."),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name) create.mutate({ name, active });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Novo webhook</DialogTitle>
            <DialogDescription>Depois de criar, você configura as credenciais do LivePix e gera o token do plugin.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="webhook-name">Nome</Label>
            <Input id="webhook-name" name="name" maxLength={80} placeholder="Subathon de setembro" required autoFocus />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <Label htmlFor="webhook-active">Ativo</Label>
              <p className="text-xs text-muted-foreground">Inativo, as notificações ficam registradas mas não viram doações.</p>
            </div>
            <Switch id="webhook-active" checked={active} onCheckedChange={setActive} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Criar e configurar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
