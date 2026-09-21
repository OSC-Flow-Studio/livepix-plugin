import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Auth } from "./auth.js";
import type { SecretBox } from "./crypto.js";
import type { Db } from "./db.js";
import type { Processor } from "./processor.js";
import type { RealtimeHub } from "./realtime.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { publicRoutes } from "./routes/public.js";

export interface AppDeps {
  db: Db;
  auth: Auth;
  secrets: SecretBox;
  processor: Processor;
  hub: RealtimeHub;
  publicUrl: string;
  /** Built frontend; omitted in tests and when Vite serves it in development. */
  webDist?: string;
  heartbeatMs?: number;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.get("/healthz", async (c) => {
    await deps.db.$queryRaw`SELECT 1`;
    return c.json({ ok: true });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.route("/api", dashboardRoutes(deps));
  app.route("/", publicRoutes({ ...deps, upgradeWebSocket }));

  const indexPath = deps.webDist ? join(deps.webDist, "index.html") : "";
  if (deps.webDist && existsSync(indexPath)) {
    const indexHtml = readFileSync(indexPath, "utf8");
    app.use("/assets/*", serveStatic({ root: deps.webDist }));
    app.use("*", serveStatic({ root: deps.webDist }));
    // Client-side routes (/login, /webhooks/<id>) all load the same page.
    app.get("*", (c) => c.html(indexHtml));
  }

  return { app, injectWebSocket };
}
