import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { randomId, type SecretBox } from "../crypto.js";
import type { Db } from "../db.js";
import type { Processor } from "../processor.js";
import type { RealtimeHub } from "../realtime.js";
import type { Webhook } from "../../generated/prisma/client.js";
import { toPluginDonation } from "../dto.js";

export interface DashboardDeps {
  db: Db;
  auth: Auth;
  secrets: SecretBox;
  processor: Processor;
  hub: RealtimeHub;
  publicUrl: string;
}

type SessionUser = { id: string; email: string; name: string };
type Env = { Variables: { user: SessionUser } };

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  livepixClientId: z.string().trim().max(200).optional(),
  /** A new secret replaces the stored one; an empty string removes it. Absent keeps it. */
  livepixClientSecret: z.string().trim().max(500).optional(),
});

const pageSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Close codes the plugin understands: it stops retrying with the same token on these. */
export const CLOSE_TOKEN_REVOKED = 4001;
export const CLOSE_WEBHOOK_INACTIVE = 4003;
export const CLOSE_WEBHOOK_DELETED = 4004;

export function dashboardRoutes(deps: DashboardDeps) {
  const { db, auth, secrets, processor, hub } = deps;
  const base = deps.publicUrl.replace(/\/+$/, "");
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
    await next();
  });

  async function owned(userId: string, id: string): Promise<Webhook | null> {
    return db.webhook.findFirst({ where: { id, userId } });
  }

  function urls(id: string) {
    const wsBase = base.replace(/^http/, "ws");
    return {
      webhookUrl: `${base}/${id}/livepix`,
      apiUrl: `${base}/${id}/api`,
      websocketUrl: `${wsBase}/${id}/websocket`,
    };
  }

  async function view(webhook: Webhook) {
    const [deliveries, donations, pending, lastDelivery] = await Promise.all([
      db.delivery.count({ where: { webhookId: webhook.id } }),
      db.donation.count({ where: { webhookId: webhook.id } }),
      db.delivery.count({ where: { webhookId: webhook.id, status: { in: ["pending", "failed"] } } }),
      db.delivery.findFirst({ where: { webhookId: webhook.id }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    ]);
    return {
      id: webhook.id,
      name: webhook.name,
      active: webhook.active,
      livepixClientId: webhook.livepixClientId ?? "",
      hasLivepixClientSecret: Boolean(webhook.livepixClientSecretEnc),
      token: webhook.apiKeyId
        ? { start: webhook.apiKeyStart ?? "", createdAt: webhook.apiKeyCreatedAt?.toISOString() ?? null }
        : null,
      ...urls(webhook.id),
      stats: {
        deliveries,
        donations,
        pending,
        sockets: hub.count(webhook.id),
        lastDeliveryAt: lastDelivery?.receivedAt.toISOString() ?? null,
      },
      createdAt: webhook.createdAt.toISOString(),
      updatedAt: webhook.updatedAt.toISOString(),
    };
  }

  async function revokeToken(webhook: Webhook, headers: Headers) {
    if (!webhook.apiKeyId) return;
    try {
      await auth.api.deleteApiKey({ body: { keyId: webhook.apiKeyId }, headers });
    } catch {
      // Already gone from the key store; clearing the webhook's pointer below is what matters.
      await db.apikey.deleteMany({ where: { id: webhook.apiKeyId } });
    }
    await db.webhook.update({
      where: { id: webhook.id },
      data: { apiKeyId: null, apiKeyStart: null, apiKeyCreatedAt: null },
    });
    hub.disconnect(webhook.id, CLOSE_TOKEN_REVOKED, "token revogado");
  }

  app.get("/me", (c) => c.json({ user: c.get("user") }));

  app.get("/webhooks", async (c) => {
    const webhooks = await db.webhook.findMany({ where: { userId: c.get("user").id }, orderBy: { createdAt: "asc" } });
    return c.json({ webhooks: await Promise.all(webhooks.map(view)) });
  });

  app.post("/webhooks", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
    const webhook = await db.webhook.create({
      data: { id: randomId(), userId: c.get("user").id, name: parsed.data.name, active: parsed.data.active },
    });
    return c.json({ webhook: await view(webhook) }, 201);
  });

  app.get("/webhooks/:id", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    return c.json({ webhook: await view(webhook) });
  });

  app.patch("/webhooks/:id", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
    const input = parsed.data;
    const data: Partial<Webhook> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.active !== undefined) data.active = input.active;
    if (input.livepixClientId !== undefined) data.livepixClientId = input.livepixClientId || null;
    if (input.livepixClientSecret !== undefined) {
      data.livepixClientSecretEnc = input.livepixClientSecret ? secrets.seal(input.livepixClientSecret) : null;
    }
    const updated = await db.webhook.update({ where: { id: webhook.id }, data });
    if (webhook.active && !updated.active) hub.disconnect(webhook.id, CLOSE_WEBHOOK_INACTIVE, "webhook inativo");
    const credentialsChanged = input.livepixClientId !== undefined || input.livepixClientSecret !== undefined;
    if (updated.active && (credentialsChanged || (!webhook.active && updated.active))) {
      await processor.requeueWebhook(webhook.id);
    }
    return c.json({ webhook: await view(updated) });
  });

  app.delete("/webhooks/:id", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    if (webhook.apiKeyId) await db.apikey.deleteMany({ where: { id: webhook.apiKeyId } });
    await db.webhook.delete({ where: { id: webhook.id } });
    hub.disconnect(webhook.id, CLOSE_WEBHOOK_DELETED, "webhook removido");
    return c.json({ ok: true });
  });

  /** Issues a new plugin token. Any previous token stops working at once. */
  app.post("/webhooks/:id/token", async (c) => {
    const user = c.get("user");
    const webhook = await owned(user.id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    await revokeToken(webhook, c.req.raw.headers);
    const created = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: webhook.name.slice(0, 32),
        prefix: `olp_${webhook.id}_`,
        metadata: { webhookId: webhook.id },
        rateLimitEnabled: false,
      },
    });
    const updated = await db.webhook.update({
      where: { id: webhook.id },
      data: { apiKeyId: created.id, apiKeyStart: created.start ?? created.key.slice(0, 36), apiKeyCreatedAt: new Date() },
    });
    return c.json({ token: created.key, webhook: await view(updated) }, 201);
  });

  app.delete("/webhooks/:id/token", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    await revokeToken(webhook, c.req.raw.headers);
    const updated = await db.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
    return c.json({ webhook: await view(updated) });
  });

  app.get("/webhooks/:id/deliveries", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const page = pageSchema.parse(c.req.query());
    const rows = await db.delivery.findMany({
      where: { webhookId: webhook.id },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        receivedAt: true,
        status: true,
        event: true,
        resourceType: true,
        resourceId: true,
        attempts: true,
        lastError: true,
        nextAttemptAt: true,
        donation: { select: { amount: true, currency: true, username: true } },
      },
    });
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit);
    return c.json({
      deliveries: items.map((row) => ({
        ...row,
        receivedAt: row.receivedAt.toISOString(),
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    });
  });

  app.get("/webhooks/:id/deliveries/:deliveryId", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const delivery = await db.delivery.findFirst({
      where: { id: c.req.param("deliveryId"), webhookId: webhook.id },
      include: { donation: true },
    });
    if (!delivery) return c.json({ error: "not_found" }, 404);
    return c.json({
      delivery: {
        ...delivery,
        lockedUntil: undefined,
        receivedAt: delivery.receivedAt.toISOString(),
        processedAt: delivery.processedAt?.toISOString() ?? null,
        nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
        donation: delivery.donation ? toPluginDonation(delivery.donation) : null,
      },
    });
  });

  /** Runs a failed or ignored delivery again, for example after fixing the credentials. */
  app.post("/webhooks/:id/deliveries/:deliveryId/reprocess", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const reset = await db.delivery.updateMany({
      where: { id: c.req.param("deliveryId"), webhookId: webhook.id, status: { in: ["failed", "ignored"] } },
      data: { status: "pending", nextAttemptAt: new Date(), attempts: 0, lastError: null, lockedUntil: null },
    });
    if (reset.count !== 1) return c.json({ error: "not_reprocessable" }, 409);
    const delivery = await processor.process(c.req.param("deliveryId"));
    return c.json({ status: delivery?.status ?? "pending", lastError: delivery?.lastError ?? null });
  });

  app.get("/webhooks/:id/donations", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    const parsed = pageSchema.extend({ since: z.iso.datetime({ offset: true }).optional(), search: z.string().max(200).optional() }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const page = parsed.data;
    const rows = await db.donation.findMany({
      where: { webhookId: webhook.id,
        ...(page.since ? { occurredAt: { gte: new Date(page.since) } } : {}),
        ...(page.search ? { OR: ["key", "livepixId", "reference", "username", "message"].map((field) => ({ [field]: { contains: page.search, mode: "insensitive" as const } })) } : {}),
      },
      orderBy: { seq: "desc" },
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > page.limit;
    const items = rows.slice(0, page.limit);
    return c.json({
      donations: items.map((row) => ({ ...toPluginDonation(row), rowId: row.id, accountedAt: row.accountedAt?.toISOString() ?? null,
        lastResentAt: row.lastResentAt?.toISOString() ?? null, resendCount: row.resendCount })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    });
  });

  app.post("/webhooks/:id/donations/import", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    if (!webhook.active) return c.json({ error: "webhook_inactive" }, 409);
    const parsed = z.object({ since: z.iso.datetime({ offset: true }), resource: z.enum(["messages", "payments"]), page: z.number().int().min(1).max(1_000_000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    try {
      return c.json(await processor.importPage(webhook, new Date(parsed.data.since), parsed.data.resource, parsed.data.page));
    } catch {
      return c.json({ error: "history_unavailable" }, 502);
    }
  });

  app.post("/webhooks/:id/donations/:donationId/resend", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    if (!webhook.active) return c.json({ error: "webhook_inactive" }, 409);
    const donation = await db.donation.findFirst({ where: { id: c.req.param("donationId"), webhookId: webhook.id } });
    if (!donation) return c.json({ error: "not_found" }, 404);
    const sent = hub.publish(webhook.id, { type: "donation.replay", requestId: randomId(), donation: toPluginDonation(donation) });
    if (!sent) return c.json({ error: "plugin_offline" }, 409);
    await db.donation.update({ where: { id: donation.id }, data: { lastResentAt: new Date(), resendCount: { increment: 1 } } });
    return c.json({ ok: true, sent });
  });

  app.post("/webhooks/:id/donations/recover", async (c) => {
    const webhook = await owned(c.get("user").id, c.req.param("id"));
    if (!webhook) return c.json({ error: "not_found" }, 404);
    if (!webhook.active) return c.json({ error: "webhook_inactive" }, 409);
    const sent = hub.publish(webhook.id, { type: "donations.recover", requestId: randomId() });
    if (!sent) return c.json({ error: "plugin_offline" }, 409);
    return c.json({ ok: true, sent });
  });

  return app;
}
