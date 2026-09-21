import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Loader2, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { CopyField } from "@/components/copy-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError, formatDateTime, type WebhookView } from "@/lib/api";
import { DebugPanel } from "@/pages/webhook-debug";
import { DonationsPanel } from "@/pages/webhook-donations";

type Patch = Partial<{ name: string; active: boolean; livepixClientId: string; livepixClientSecret: string }>;

export function WebhookDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const webhook = useQuery({
    queryKey: ["webhook", id],
    queryFn: () => api<{ webhook: WebhookView }>(`/webhooks/${id}`).then((r) => r.webhook),
    refetchInterval: 10_000,
  });

  const setCached = (next: WebhookView) => {
    queryClient.setQueryData(["webhook", id], next);
    void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
  };

  const patch = useMutation({
    mutationFn: (body: Patch) => api<{ webhook: WebhookView }>(`/webhooks/${id}`, { method: "PATCH", body }).then((r) => r.webhook),
    onSuccess: setCached,
    onError: () => toast.error("Não foi possível salvar."),
  });

  const remove = useMutation({
    mutationFn: () => api(`/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      toast.success("Webhook removido.");
      navigate("/", { replace: true });
    },
    onError: () => toast.error("Não foi possível remover o webhook."),
  });

  if (webhook.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (webhook.isError || !webhook.data) {
    const missing = webhook.error instanceof ApiError && webhook.error.status === 404;
    return (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">{missing ? "Este webhook não existe ou não é seu." : "Não foi possível carregar o webhook."}</p>
        <Button variant="outline" className="w-fit" asChild>
          <Link to="/">
            <ArrowLeft aria-hidden />
            Voltar
          </Link>
        </Button>
      </div>
    );
  }

  const data = webhook.data;
  const baseUrl = data.apiUrl.slice(0, data.apiUrl.length - `/${data.id}/api`.length);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="icon" asChild aria-label="Voltar para a lista">
            <Link to="/">
              <ArrowLeft aria-hidden />
            </Link>
          </Button>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{data.name}</h1>
          <Badge variant="outline" className={data.active ? "border-success/30 text-success" : "text-muted-foreground"}>
            {data.active ? "Ativo" : "Inativo"}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="active"
              checked={data.active}
              disabled={patch.isPending}
              onCheckedChange={(active) => patch.mutate({ active })}
            />
            <Label htmlFor="active">Ativo</Label>
          </div>
          <DeleteButton name={data.name} pending={remove.isPending} onConfirm={() => remove.mutate()} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>URL para o LivePix</CardTitle>
            <CardDescription>
              No painel do LivePix (dashboard.livepix.gg), cadastre esta URL como webhook da sua conta.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <CopyField id="webhook-url" label="URL do webhook para o LivePix" value={data.webhookUrl} concealed />
            <Alert className="border-warning/40 text-warning [&>svg]:text-warning">
              <ShieldAlert aria-hidden />
              <AlertTitle>Não compartilhe este link</AlertTitle>
              <AlertDescription className="text-warning/90">
                O LivePix não aceita senha em webhooks, então o link é a única proteção. Não mostre na live nem mande
                para ninguém. Cada notificação é conferida na API do LivePix antes de virar doação, mas quem tiver o
                link consegue encher o seu histórico. Se vazar, apague este webhook e crie outro.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <CredentialsCard webhook={data} pending={patch.isPending} onSave={(body) => patch.mutate(body)} />

        <PluginCard webhook={data} baseUrl={baseUrl} onChange={setCached} />

        <NameCard webhook={data} pending={patch.isPending} onSave={(name) => patch.mutate({ name })} />
      </div>

      <Tabs defaultValue="debug">
        <TabsList>
          <TabsTrigger value="debug">Depuração ({data.stats.deliveries})</TabsTrigger>
          <TabsTrigger value="donations">Doações ({data.stats.donations})</TabsTrigger>
        </TabsList>
        <TabsContent value="debug">
          <DebugPanel webhookId={data.id} />
        </TabsContent>
        <TabsContent value="donations">
          <DonationsPanel webhookId={data.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DeleteButton({ name, pending, onConfirm }: { name: string; pending: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
        Remover
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              A URL deixa de funcionar, o token do plugin é revogado e todo o histórico de notificações e doações deste
              webhook é apagado. Não dá para desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending && <Loader2 className="animate-spin" aria-hidden />}
              Remover webhook
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CredentialsCard({ webhook, pending, onSave }: { webhook: WebhookView; pending: boolean; onSave: (body: Patch) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const secret = String(form.get("clientSecret") ?? "").trim();
    onSave({
      livepixClientId: String(form.get("clientId") ?? "").trim(),
      ...(secret ? { livepixClientSecret: secret } : {}),
    });
    event.currentTarget.reset();
  }
  const missing = !webhook.livepixClientId || !webhook.hasLivepixClientSecret;

  return (
    <Card>
      <form onSubmit={submit} className="flex h-full flex-col gap-6">
        <CardHeader>
          <CardTitle>Credenciais do LivePix</CardTitle>
          <CardDescription>
            A notificação do LivePix só diz qual doação chegou. Com um aplicativo OAuth (escopos payments:read e
            messages:read), o dashboard lê valor, nome e mensagem.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid flex-1 gap-4">
          {missing && (
            <Alert variant="destructive">
              <AlertDescription>Sem credenciais, as notificações ficam guardadas e são lidas assim que você salvar.</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="clientId">Client ID</Label>
            <Input id="clientId" name="clientId" defaultValue={webhook.livepixClientId} key={webhook.livepixClientId} autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="clientSecret">Client Secret</Label>
            <Input
              id="clientSecret"
              name="clientSecret"
              type="password"
              autoComplete="new-password"
              placeholder={webhook.hasLivepixClientSecret ? "Salvo. Preencha só para trocar." : ""}
            />
            <p className="text-xs text-muted-foreground">Guardado criptografado. Nunca é exibido de novo.</p>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Salvar credenciais
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function PluginCard({ webhook, baseUrl, onChange }: { webhook: WebhookView; baseUrl: string; onChange: (next: WebhookView) => void }) {
  const [issued, setIssued] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const generate = useMutation({
    mutationFn: () => api<{ token: string; webhook: WebhookView }>(`/webhooks/${webhook.id}/token`, { method: "POST" }),
    onSuccess: (result) => {
      onChange(result.webhook);
      setIssued(result.token);
    },
    onError: () => toast.error("Não foi possível gerar o token."),
  });
  const revoke = useMutation({
    mutationFn: () => api<{ webhook: WebhookView }>(`/webhooks/${webhook.id}/token`, { method: "DELETE" }),
    onSuccess: (result) => {
      onChange(result.webhook);
      setConfirmRevoke(false);
      toast.success("Token revogado. O plugin foi desconectado.");
    },
    onError: () => toast.error("Não foi possível revogar o token."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plugin do OSC Flow Studio</CardTitle>
        <CardDescription>
          No plugin LivePix, informe a URL base e o token. Ele recebe as doações pelo WebSocket e consulta a API quando a
          conexão cai.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="base-url">URL base da API</Label>
          <CopyField id="base-url" value={baseUrl} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">Token</p>
            <p className="truncate text-xs text-muted-foreground">
              {webhook.token
                ? `Gerado em ${formatDateTime(webhook.token.createdAt)} · ${webhook.stats.sockets} plugin(s) conectado(s)`
                : "Nenhum token ativo. O plugin não consegue se conectar."}
            </p>
          </div>
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {webhook.token && (
          <Button variant="outline" onClick={() => setConfirmRevoke(true)}>
            Revogar
          </Button>
        )}
        <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
          {webhook.token ? "Gerar novo token" : "Gerar token"}
        </Button>
      </CardFooter>

      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        {/* Focus would land on the hidden token and highlight it; the copy button is one Tab away. */}
        <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Copie o token agora</DialogTitle>
            <DialogDescription>
              Ele aparece só desta vez. Cole no campo Token do plugin LivePix no OSC Flow Studio. Um token anterior, se
              havia, já parou de funcionar.
            </DialogDescription>
          </DialogHeader>
          {issued && <CopyField id="issued-token" label="Token do plugin" value={issued} concealed />}
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Já copiei</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar o token?</AlertDialogTitle>
            <AlertDialogDescription>
              O plugin conectado é desligado na hora e para de receber doações até você gerar outro token. As doações
              continuam sendo guardadas aqui.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              {revoke.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Revogar token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function NameCard({ webhook, pending, onSave }: { webhook: WebhookView; pending: boolean; onSave: (name: string) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name && name !== webhook.name) onSave(name);
  }
  return (
    <Card>
      <form onSubmit={submit} className="flex h-full flex-col gap-6">
        <CardHeader>
          <CardTitle>Identificação</CardTitle>
          <CardDescription>Só para você reconhecer o webhook na lista.</CardDescription>
        </CardHeader>
        <CardContent className="grid flex-1 content-start gap-2">
          <Label htmlFor="name">Nome</Label>
          <Input id="name" name="name" defaultValue={webhook.name} key={webhook.name} maxLength={80} required />
          <p className="text-xs text-muted-foreground">
            Criado em {formatDateTime(webhook.createdAt)} · {webhook.stats.pending} notificação(ões) aguardando leitura
          </p>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Salvar nome
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
