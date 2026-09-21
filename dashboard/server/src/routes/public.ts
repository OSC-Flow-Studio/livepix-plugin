import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod";
import { webhookIdFromToken, type Auth } from "../auth.js";
import type { Db } from "../db.js";
import { toPluginDonation } from "../dto.js";
import { parseNotification, type Processor } from "../processor.js";
import type { RealtimeHub } from "../realtime.js";
import type { Webhook } from "../../generated/prisma/client.js";

export interface PublicDeps {
  db: Db;
  auth: Auth;
  processor: Processor;
  hub: RealtimeHub;
  upgradeWebSocket: UpgradeWebSocket;
  heartbeatMs?: number;
}

const MAX_WEBHOOK_BODY = 256 * 1024;

const listSchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  after: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

type Authorized = { webhook: Webhook };
type Env = { Variables: Authorized };

function tokenFrom(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  return (bearer?.[1] ?? c.req.header("x-api-key") ?? "").trim();
}

function remoteIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function publicRoutes(deps: PublicDeps) {
  const { db, auth, processor, hub } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 25_000;
  const app = new Hono<Env>();

  /**
   * The LivePix entry point. It cannot carry a password, so the unguessable id is the
   * only gate. Every request is written down before anything else; LivePix only hears
   * 200 once the row exists, and retries on its own (every 10 min for 24 h) otherwise.
   */
  app.post("/:id/livepix", bodyLimit({ maxSize: MAX_WEBHOOK_BODY, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    const webhook = await db.webhook.findUnique({ where: { id: c.req.param("id") }, select: { id: true, active: true } });
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const body = await c.req.text();
    const notification = parseNotification(body);
    const url = new URL(c.req.url);
    const delivery = await db.delivery.create({
      data: {
        webhookId: webhook.id,
        method: c.req.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        body,
        remoteIp: remoteIp(c),
        event: notification?.event || null,
        resourceType: notification?.resourceType || null,
        resourceId: notification?.resourceId || null,
        ...(webhook.active
          ? {}
          : { status: "ignored", lastError: "Webhook inativo quando a notificação chegou.", nextAttemptAt: null, processedAt: new Date() }),
      },
    });
    if (webhook.active) void processor.process(delivery.id).catch(() => {});
    return c.json({ ok: true, delivery: delivery.id });
  });

  /** Opening the URL in a browser only confirms it exists; nothing is recorded. */
  app.get("/:id/livepix", async (c) => {
    const webhook = await db.webhook.findUnique({ where: { id: c.req.param("id") }, select: { id: true } });
    if (!webhook) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true, message: "Endpoint do LivePix. Configure esta URL no painel do LivePix." });
  });

  async function authorize(c: Context<Env>): Promise<Response | null> {
    const id = c.req.param("id") ?? "";
    const token = tokenFrom(c);
    if (!token || webhookIdFromToken(token) !== id) return c.json({ error: "unauthorized" }, 401);
    const result = await auth.api.verifyApiKey({ body: { key: token } });
    if (!result.valid || !result.key) return c.json({ error: "unauthorized" }, 401);
    const webhook = await db.webhook.findUnique({ where: { id } });
    if (!webhook || webhook.apiKeyId !== result.key.id || result.key.metadata?.webhookId !== id) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!webhook.active) return c.json({ error: "webhook_inactive" }, 403);
    c.set("webhook", webhook);
    return null;
  }

  async function latestSeq(webhookId: string): Promise<string> {
    const last = await db.donation.findFirst({ where: { webhookId }, orderBy: { seq: "desc" }, select: { seq: true } });
    return last?.seq.toString() ?? "0";
  }

  app.use("/:id/api", async (c, next) => (await authorize(c)) ?? next());
  app.use("/:id/api/*", async (c, next) => (await authorize(c)) ?? next());

  app.get("/:id/api", async (c) => {
    const webhook = c.get("webhook");
    return c.json({
      webhook: { id: webhook.id, name: webhook.name, active: webhook.active },
      latestSeq: await latestSeq(webhook.id),
      serverTime: new Date().toISOString(),
    });
  });

  /**
   * Donations in arrival order. `since` filters by when the donation happened in LivePix
   * (the subathon start); `after` continues from the last `seq` of the previous page.
   */
  app.get("/:id/api/donations", async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
    const { since, after, limit } = parsed.data;
    const webhook = c.get("webhook");
    const rows = await db.donation.findMany({
      where: {
        webhookId: webhook.id,
        ...(since ? { occurredAt: { gte: new Date(since) } } : {}),
        ...(after ? { seq: { gt: BigInt(after) } } : {}),
      },
      orderBy: { seq: "asc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return c.json({
      donations: page.map(toPluginDonation),
      nextAfter: page.length > 0 ? page[page.length - 1]!.seq.toString() : after ?? null,
      hasMore,
      serverTime: new Date().toISOString(),
    });
  });

  app.get(
    "/:id/websocket",
    async (c, next) => (await authorize(c)) ?? next(),
    deps.upgradeWebSocket((c) => {
      const webhook = (c as Context<Env>).get("webhook");
      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      return {
        async onOpen(_event, ws) {
          unsubscribe = hub.subscribe(webhook.id, {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          });
          heartbeat = setInterval(() => {
            ws.send(JSON.stringify({ type: "heartbeat", serverTime: new Date().toISOString() }));
          }, heartbeatMs);
          ws.send(JSON.stringify({
            type: "hello",
            webhook: { id: webhook.id, name: webhook.name },
            latestSeq: await latestSeq(webhook.id),
            serverTime: new Date().toISOString(),
          }));
        },
        onMessage(event, ws) {
          if (typeof event.data !== "string") return;
          try {
            const message = JSON.parse(event.data) as { type?: unknown };
            if (message.type === "ping") ws.send(JSON.stringify({ type: "pong", serverTime: new Date().toISOString() }));
          } catch {
            // The plugin only sends pings; anything else is ignored.
          }
        },
        onClose() {
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe?.();
        },
      };
    }),
  );

  return app;
}
