import type { SecretBox } from "./crypto.js";
import type { Db } from "./db.js";
import { toPluginDonation } from "./dto.js";
import { LivePixError, type LivePixClient, type LivePixCredentials } from "./livepix/client.js";
import { donationKey, toDonation, type DonationInput } from "./livepix/donation.js";
import type { RealtimeHub } from "./realtime.js";
import { Prisma, type Delivery, type Donation, type Webhook } from "../generated/prisma/client.js";

const LOCK_MS = 60_000;
const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** A payment notification looks for its message among the latest ones to read name and text. */
const MESSAGE_LOOKBACK = 20;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ProcessorOptions {
  db: Db;
  livepix: LivePixClient;
  secrets: SecretBox;
  hub: RealtimeHub;
  logger?: Logger;
}

type Outcome =
  | { status: "processed" | "duplicate"; donation: Donation }
  | { status: "ignored"; reason: string };

/** A failure that no automatic retry will fix: the user has to change something first. */
class PermanentError extends Error {}

interface LivePixNotification {
  event: string;
  resourceType: string;
  resourceId: string;
}

export function parseNotification(body: string): LivePixNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { event?: unknown; resource?: { id?: unknown; type?: unknown } };
  const resource = record.resource && typeof record.resource === "object" ? record.resource : {};
  return {
    event: typeof record.event === "string" ? record.event : "",
    resourceType: typeof resource.type === "string" ? resource.type : "",
    resourceId: typeof resource.id === "string" ? resource.id : "",
  };
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export function createProcessor(options: ProcessorOptions) {
  const { db, livepix, secrets, hub } = options;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };
  let timer: NodeJS.Timeout | null = null;
  let draining: Promise<void> | null = null;

  function credentialsOf(webhook: Webhook): LivePixCredentials {
    if (!webhook.livepixClientId || !webhook.livepixClientSecretEnc) {
      throw new PermanentError("Configure o Client ID e o Client Secret do LivePix neste webhook para ler as doações.");
    }
    let clientSecret: string;
    try {
      clientSecret = secrets.open(webhook.livepixClientSecretEnc);
    } catch {
      throw new PermanentError("O Client Secret salvo não pôde ser lido. Informe-o de novo.");
    }
    return { clientId: webhook.livepixClientId, clientSecret };
  }

  async function readDonation(webhook: Webhook, notification: LivePixNotification, receivedAt: Date) {
    const credentials = credentialsOf(webhook);
    if (notification.resourceType === "message") {
      const item = await livepix.get(credentials, "messages", notification.resourceId);
      return toDonation(item, "message", receivedAt);
    }
    const payment = toDonation(await livepix.get(credentials, "payments", notification.resourceId), "payment", receivedAt);
    // A donation with text also exists as a message. Reading it here keeps name and text on
    // the first event the plugin sees, whichever notification LivePix delivered first.
    try {
      const messages = await livepix.list(credentials, "messages", MESSAGE_LOOKBACK);
      const match = messages.find((item) => donationKey(item) === payment.key);
      if (match) {
        const message = toDonation(match, "message", receivedAt);
        return { ...payment, username: message.username, message: message.message, flagged: message.flagged };
      }
    } catch (error) {
      logger.warn(`webhook ${webhook.id}: lista de mensagens indisponível, seguindo só com o pagamento: ${describe(error)}`);
    }
    return payment;
  }

  async function store(webhook: Webhook, input: DonationInput): Promise<Outcome> {
    const existing = await db.donation.findUnique({ where: { webhookId_key: { webhookId: webhook.id, key: input.key } } });
    if (existing) {
      // The second notification for the same donation. It may carry the text the first one lacked;
      // the stored row learns it, but the plugin is not told twice about one donation.
      if (!existing.message && input.message) {
        const updated = await db.donation.update({
          where: { id: existing.id },
          data: { username: input.username, message: input.message, flagged: input.flagged },
        });
        return { status: "duplicate", donation: updated };
      }
      return { status: "duplicate", donation: existing };
    }
    try {
      const donation = await db.donation.create({
        data: {
          webhookId: webhook.id,
          key: input.key,
          occurredAt: input.occurredAt,
          amount: input.amount,
          currency: input.currency,
          username: input.username,
          message: input.message,
          flagged: input.flagged,
          livepixId: input.livepixId,
          proof: input.proof,
          reference: input.reference,
          source: input.source,
          raw: input.raw as Prisma.InputJsonObject,
        },
      });
      hub.publish(webhook.id, { type: "donation", donation: toPluginDonation(donation) });
      return { status: "processed", donation };
    } catch (error) {
      // Two notifications for one donation processed at the same moment: the other one won.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await db.donation.findUniqueOrThrow({
          where: { webhookId_key: { webhookId: webhook.id, key: input.key } },
        });
        return { status: "duplicate", donation: winner };
      }
      throw error;
    }
  }

  async function handle(delivery: Delivery & { webhook: Webhook }): Promise<Outcome> {
    if (!delivery.webhook.active) return { status: "ignored", reason: "Webhook inativo quando a notificação foi processada." };
    const notification = parseNotification(delivery.body);
    if (!notification) return { status: "ignored", reason: "Corpo não é um JSON do LivePix." };
    if (notification.event !== "new") {
      return { status: "ignored", reason: `Evento "${notification.event || "vazio"}" não gera doação.` };
    }
    if (notification.resourceType !== "message" && notification.resourceType !== "payment") {
      return { status: "ignored", reason: `Recurso "${notification.resourceType || "vazio"}" não é uma doação.` };
    }
    if (!notification.resourceId) return { status: "ignored", reason: "Notificação sem resource.id." };
    const input = await readDonation(delivery.webhook, notification, delivery.receivedAt);
    return store(delivery.webhook, input);
  }

  /**
   * Claims one delivery and processes it. The claim is a conditional update, so two
   * workers (or the ingest call and the worker) never process the same delivery at once.
   */
  async function process(deliveryId: string): Promise<Delivery | null> {
    const now = new Date();
    const claimed = await db.delivery.updateMany({
      where: {
        id: deliveryId,
        status: { in: ["pending", "failed"] },
        nextAttemptAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: { lockedUntil: new Date(now.getTime() + LOCK_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    const delivery = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { webhook: true } });
    try {
      const outcome = await handle(delivery);
      if (outcome.status === "ignored") {
        return await db.delivery.update({
          where: { id: deliveryId },
          data: { status: "ignored", lastError: outcome.reason, lockedUntil: null, nextAttemptAt: null, processedAt: new Date() },
        });
      }
      return await db.delivery.update({
        where: { id: deliveryId },
        data: {
          status: outcome.status,
          donationId: outcome.donation.id,
          lastError: null,
          lockedUntil: null,
          nextAttemptAt: null,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      const retryable = !(error instanceof PermanentError)
        && (!(error instanceof LivePixError) || error.retryable)
        && delivery.attempts < MAX_ATTEMPTS;
      const message = describe(error);
      logger.warn(`entrega ${deliveryId} falhou (tentativa ${delivery.attempts}): ${message}`);
      return db.delivery.update({
        where: { id: deliveryId },
        data: {
          status: "failed",
          lastError: message,
          lockedUntil: null,
          nextAttemptAt: retryable ? new Date(Date.now() + backoffMs(delivery.attempts)) : null,
        },
      });
    }
  }

  async function drain(): Promise<void> {
    const due = await db.delivery.findMany({
      where: {
        status: { in: ["pending", "failed"] },
        nextAttemptAt: { lte: new Date() },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
      },
      orderBy: { receivedAt: "asc" },
      select: { id: true },
      take: 25,
    });
    for (const { id } of due) await process(id);
  }

  function tick() {
    if (draining) return;
    draining = drain()
      .catch((error) => logger.warn("fila de entregas: " + describe(error)))
      .finally(() => { draining = null; });
  }

  return {
    process,
    drain,
    /** Retries what failed only for lack of credentials, after the user saved them. */
    async requeueWebhook(webhookId: string): Promise<number> {
      const result = await db.delivery.updateMany({
        where: { webhookId, status: "failed", nextAttemptAt: null },
        data: { nextAttemptAt: new Date(), attempts: 0 },
      });
      if (result.count > 0) tick();
      return result.count;
    },
    start(intervalMs = 10_000) {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await draining;
    },
  };
}

export type Processor = ReturnType<typeof createProcessor>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
