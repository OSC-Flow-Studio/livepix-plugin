import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth-client";

type Mode = "sign-in" | "sign-up";

const ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-mail ou senha incorretos.",
  USER_ALREADY_EXISTS: "Já existe uma conta com este e-mail. Entre com ela.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "Já existe uma conta com este e-mail. Entre com ela.",
  PASSWORD_TOO_SHORT: "A senha precisa de pelo menos 8 caracteres.",
  EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED: "Novos cadastros estão desativados neste servidor.",
};

export function LoginPage() {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (session.data) return <Navigate to={from} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setError("");
    setPending(true);
    const result = mode === "sign-in"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: String(form.get("name") ?? "").trim() || email });
    setPending(false);
    if (result.error) {
      setError(ERRORS[result.error.code ?? ""] ?? result.error.message ?? "Não foi possível continuar.");
      return;
    }
    navigate(from, { replace: true });
  }

  const fields = (
    <>
      {mode === "sign-up" && (
        <div className="grid gap-2">
          <Label htmlFor="name">Nome</Label>
          <Input id="name" name="name" autoComplete="name" placeholder="Como quer ser chamado" />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Senha</Label>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          required
        />
        {mode === "sign-up" && <p className="text-xs text-muted-foreground">Pelo menos 8 caracteres.</p>}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending && <Loader2 className="animate-spin" aria-hidden />}
        {mode === "sign-in" ? "Entrar" : "Criar conta"}
      </Button>
    </>
  );

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="inline-block size-2.5 rounded-full bg-primary" aria-hidden />
            OSC LivePix Dashboard
          </CardTitle>
          <CardDescription>
            Recebe as doações do seu LivePix e entrega ao OSC Flow Studio em tempo real.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={mode} onValueChange={(value) => { setMode(value as Mode); setError(""); }}>
            <TabsList className="mb-4 grid w-full grid-cols-2">
              <TabsTrigger value="sign-in">Entrar</TabsTrigger>
              <TabsTrigger value="sign-up">Criar conta</TabsTrigger>
            </TabsList>
            <TabsContent value={mode}>
              <form className="grid gap-4" onSubmit={submit}>
                {fields}
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
