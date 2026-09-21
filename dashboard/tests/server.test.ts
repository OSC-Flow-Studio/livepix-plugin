import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Browser, openSocket, startHarness, until, type Harness } from "./harness.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

beforeEach(() => {
  h.livepix.messages.clear();
  h.livepix.payments.clear();
  h.livepix.failWith = null;
  h.livepix.calls = [];
});

interface Setup {
  browser: Browser;
  id: string;
  token: string;
  urls: { webhookUrl: string; apiUrl: string; websocketUrl: string };
}

async function setup({ credentials = true, token = true } = {}): Promise<Setup> {
  const browser = new Browser(h.base);
  await browser.signUp();
  const created = await browser.request("/api/webhooks", { method: "POST", body: { name: "Subathon" } });
  expect(created.status).toBe(201);
  const id = created.body.webhook.id as string;
  if (credentials) {
    const saved = await browser.request(`/api/webhooks/${id}`, {
      method: "PATCH",
      body: { livepixClientId: "livepix-client", livepixClientSecret: "livepix-secret" },
    });
    expect(saved.status).toBe(200);
  }
  let plain = "";
  if (token) {
    const issued = await browser.request(`/api/webhooks/${id}/token`, { method: "POST" });
    expect(issued.status).toBe(201);
    plain = issued.body.token;
  }
  return { browser, id, token: plain, urls: created.body.webhook };
}

function notify(url: string, type: "message" | "payment" | "subscription", resourceId: string, event = "new") {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "LivePix-Webhook" },
    body: JSON.stringify({ userId: "u1", clientId: "c1", event, resource: { id: resourceId, reference: "ref-" + resourceId, type } }),
  });
}

function message(id: string, proof: string, extra: Record<string, unknown> = {}) {
  return { id, proof, reference: "r-" + proof, username: "Harry", message: "Olá!", amount: 1000, currency: "BRL", flagged: false, createdAt: "2026-09-21T18:00:00-03:00", ...extra };
}

async function pluginGet(s: Setup, path: string, token = s.token) {
  const response = await fetch(`${s.urls.apiUrl}${path}`, { headers: { authorization: "Bearer " + token } });
  return { status: response.status, body: await response.json() };
}

describe("accounts and webhooks", () => {
  it("keeps the dashboard API behind a session", async () => {
    const anonymous = await fetch(`${h.base}/api/webhooks`);
    expect(anonymous.status).toBe(401);
  });

  it("creates a webhook with unguessable public URLs and never returns the LivePix secret", async () => {
    const s = await setup({ token: false });
    expect(s.id).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(s.urls.webhookUrl).toBe(`${h.base}/${s.id}/livepix`);
    expect(s.urls.apiUrl).toBe(`${h.base}/${s.id}/api`);
    expect(s.urls.websocketUrl).toBe(`${h.base.replace("http", "ws")}/${s.id}/websocket`);
    const view = await s.browser.request(`/api/webhooks/${s.id}`);
    expect(view.body.webhook.hasLivepixClientSecret).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain("livepix-secret");
    const row = await h.db.webhook.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.livepixClientSecretEnc).toMatch(/^v1\./);
    expect(row.livepixClientSecretEnc).not.toContain("livepix-secret");
  });

  it("does not let one account read another account's webhook", async () => {
    const s = await setup({ token: false });
    const stranger = new Browser(h.base);
    await stranger.signUp();
    expect((await stranger.request(`/api/webhooks/${s.id}`)).status).toBe(404);
    expect((await stranger.request(`/api/webhooks/${s.id}/token`, { method: "POST" })).status).toBe(404);
  });
});

describe("plugin token", () => {
  it("names its webhook and opens only that webhook's API", async () => {
    const s = await setup();
    expect(s.token.startsWith(`olp_${s.id}_`)).toBe(true);
    expect((await pluginGet(s, "")).status).toBe(200);
    expect((await pluginGet(s, "", "")).status).toBe(401);
    const other = await setup();
    expect((await pluginGet(s, "", other.token)).status).toBe(401);
    const tampered = s.token.slice(0, -2) + (s.token.endsWith("aa") ? "bb" : "aa");
    expect((await pluginGet(s, "", tampered)).status).toBe(401);
  });

  it("stops the old token when a new one is generated, and closes its sockets", async () => {
    const s = await setup();
    const ws = openSocket(s.urls.websocketUrl, s.token);
    await ws.next("hello");
    const rotated = await s.browser.request(`/api/webhooks/${s.id}/token`, { method: "POST" });
    expect((await ws.closed).code).toBe(4001);
    expect((await pluginGet(s, "")).status).toBe(401);
    expect((await pluginGet(s, "", rotated.body.token)).status).toBe(200);
  });

  it("revokes the token", async () => {
    const s = await setup();
    const revoked = await s.browser.request(`/api/webhooks/${s.id}/token`, { method: "DELETE" });
    expect(revoked.body.webhook.token).toBeNull();
    expect((await pluginGet(s, "")).status).toBe(401);
  });

  it("refuses a WebSocket without a valid token", async () => {
    const s = await setup();
    expect(await openSocket(s.urls.websocketUrl).rejected).toBe(401);
    expect(await openSocket(s.urls.websocketUrl, "olp_" + s.id + "_nope").rejected).toBe(401);
  });
});

describe("LivePix entry point", () => {
  it("stores the raw request, reads the donation from LivePix and pushes it over the socket", async () => {
    const s = await setup();
    const ws = openSocket(s.urls.websocketUrl, s.token);
    await ws.next("hello");
    h.livepix.messages.set("m1", message("m1", "E1"));

    const response = await notify(s.urls.webhookUrl, "message", "m1");
    expect(response.status).toBe(200);

    const pushed = await ws.next("donation");
    expect(pushed.donation).toMatchObject({
      id: "E1",
      amount: 1000,
      currency: "BRL",
      username: "Harry",
      message: "Olá!",
      hasMessage: true,
      occurredAt: "2026-09-21T21:00:00.000Z",
    });
    const delivery = await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id } });
    expect(delivery.status).toBe("processed");
    expect(delivery.resourceType).toBe("message");
    expect((delivery.headers as Record<string, string>)["user-agent"]).toBe("LivePix-Webhook");
    expect(JSON.parse(delivery.body).resource.id).toBe("m1");

    const listed = await pluginGet(s, "/donations");
    expect(listed.body.donations.map((d: { id: string }) => d.id)).toEqual(["E1"]);
    ws.socket.close();
  });

  it("answers 404 for an unknown id and records nothing", async () => {
    const before = await h.db.delivery.count();
    const response = await notify(`${h.base}/doesnotexist000000000000/livepix`, "message", "m1");
    expect(response.status).toBe(404);
    expect(await h.db.delivery.count()).toBe(before);
  });

  it("turns a payment and its message into one donation that carries the text", async () => {
    const s = await setup();
    h.livepix.payments.set("p1", { id: "p1", proof: "E2", reference: "r2", amount: 500, currency: "BRL", createdAt: "2026-09-21T18:05:00-03:00" });
    h.livepix.messages.set("m2", message("m2", "E2", { amount: 500, username: "Ana", message: "vai!" }));

    await notify(s.urls.webhookUrl, "payment", "p1");
    await notify(s.urls.webhookUrl, "message", "m2");
    await until(async () => (await h.db.delivery.count({ where: { webhookId: s.id, status: { in: ["processed", "duplicate"] } } })) === 2);

    const donations = await h.db.donation.findMany({ where: { webhookId: s.id } });
    expect(donations).toHaveLength(1);
    expect(donations[0]).toMatchObject({ key: "E2", amount: 500, username: "Ana", message: "vai!" });
    const statuses = (await h.db.delivery.findMany({ where: { webhookId: s.id }, orderBy: { receivedAt: "asc" } })).map((d) => d.status);
    expect(statuses).toEqual(["processed", "duplicate"]);
  });

  it("keeps a notification it could not read and retries it once credentials arrive", async () => {
    const s = await setup({ credentials: false });
    h.livepix.messages.set("m3", message("m3", "E3"));
    await notify(s.urls.webhookUrl, "message", "m3");
    await until(async () => (await h.db.delivery.findFirst({ where: { webhookId: s.id } }))?.status === "failed");
    const failed = await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id } });
    expect(failed.lastError).toContain("Client ID");
    expect(failed.nextAttemptAt).toBeNull();

    await s.browser.request(`/api/webhooks/${s.id}`, {
      method: "PATCH",
      body: { livepixClientId: "livepix-client", livepixClientSecret: "livepix-secret" },
    });
    await h.processor.drain();
    await until(async () => (await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id } })).status === "processed");
    expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(1);
  });

  it("schedules a retry when LivePix is down and gives up on a resource it does not know", async () => {
    const s = await setup();
    h.livepix.failWith = 503;
    await notify(s.urls.webhookUrl, "message", "m4");
    await until(async () => (await h.db.delivery.findFirst({ where: { webhookId: s.id } }))?.status === "failed");
    const down = await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id } });
    expect(down.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    h.livepix.failWith = null;
    await h.db.delivery.update({ where: { id: down.id }, data: { nextAttemptAt: new Date(0) } });
    h.livepix.messages.set("m4", message("m4", "E4"));
    await h.processor.drain();
    expect((await h.db.delivery.findUniqueOrThrow({ where: { id: down.id } })).status).toBe("processed");

    await notify(s.urls.webhookUrl, "message", "forged-id");
    await until(async () => (await h.db.delivery.count({ where: { webhookId: s.id, status: "failed" } })) === 1);
    const forged = await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id, status: "failed" } });
    expect(forged.nextAttemptAt).toBeNull();
    expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(1);
  });

  it("records but ignores subscriptions and anything that is not a new donation", async () => {
    const s = await setup();
    await notify(s.urls.webhookUrl, "subscription", "s1");
    await fetch(s.urls.webhookUrl, { method: "POST", body: "not json" });
    await until(async () => (await h.db.delivery.count({ where: { webhookId: s.id, status: "ignored" } })) === 2);
    expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(0);
  });

  it("lets the user reprocess an ignored delivery", async () => {
    const s = await setup();
    await s.browser.request(`/api/webhooks/${s.id}`, { method: "PATCH", body: { active: false } });
    h.livepix.messages.set("m5", message("m5", "E5"));
    await notify(s.urls.webhookUrl, "message", "m5");
    const ignored = await h.db.delivery.findFirstOrThrow({ where: { webhookId: s.id } });
    expect(ignored.status).toBe("ignored");
    expect(ignored.lastError).toContain("inativo");

    await s.browser.request(`/api/webhooks/${s.id}`, { method: "PATCH", body: { active: true } });
    const again = await s.browser.request(`/api/webhooks/${s.id}/deliveries/${ignored.id}/reprocess`, { method: "POST" });
    expect(again.body.status).toBe("processed");
  });
});

describe("plugin API", () => {
  it("filters by subathon start and pages by seq", async () => {
    const s = await setup();
    const times = ["2026-09-20T10:00:00Z", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z", "2026-09-21T12:00:00Z"];
    for (const [index, createdAt] of times.entries()) {
      h.livepix.messages.set(`pm${index}`, message(`pm${index}`, `P${index}`, { createdAt }));
      await notify(s.urls.webhookUrl, "message", `pm${index}`);
    }
    await until(async () => (await h.db.donation.count({ where: { webhookId: s.id } })) === 4);

    const first = await pluginGet(s, "/donations?since=2026-09-21T00:00:00.000Z&limit=2");
    expect(first.body.donations.map((d: { id: string }) => d.id)).toEqual(["P1", "P2"]);
    expect(first.body.hasMore).toBe(true);
    const second = await pluginGet(s, `/donations?since=2026-09-21T00:00:00.000Z&limit=2&after=${first.body.nextAfter}`);
    expect(second.body.donations.map((d: { id: string }) => d.id)).toEqual(["P3"]);
    expect(second.body.hasMore).toBe(false);
    expect((await pluginGet(s, "/donations?since=yesterday")).status).toBe(400);
  });

  it("closes sockets and refuses the API while the webhook is inactive", async () => {
    const s = await setup();
    const ws = openSocket(s.urls.websocketUrl, s.token);
    await ws.next("hello");
    await s.browser.request(`/api/webhooks/${s.id}`, { method: "PATCH", body: { active: false } });
    expect((await ws.closed).code).toBe(4003);
    const refused = await pluginGet(s, "");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("webhook_inactive");
  });

  it("sends heartbeats and answers pings", async () => {
    const s = await setup();
    const ws = openSocket(s.urls.websocketUrl, s.token);
    await ws.next("hello");
    await ws.next("heartbeat");
    ws.socket.send(JSON.stringify({ type: "ping" }));
    await ws.next("pong");
    ws.socket.close();
  });
});
