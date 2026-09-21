import { Loader2, LogOut } from "lucide-react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/** Every page behind it has a signed-in user; the bar on top shows who and lets them leave. */
export function RequireSession() {
  const session = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();

  if (session.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-label="Carregando" />
      </div>
    );
  }
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="inline-block size-2.5 rounded-full bg-primary" aria-hidden />
            OSC LivePix Dashboard
          </Link>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{session.data.user.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await authClient.signOut();
                navigate("/login", { replace: true });
              }}
            >
              <LogOut aria-hidden />
              Sair
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
