import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
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
  h.livepix.pages = [];
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

describe("donation recovery", () => {
  const since = "2026-09-21T12:00:00.000Z";
  const importPage = (s: Setup, page: number, resource = "messages", start = since) => s.browser.request(`/api/webhooks/${s.id}/donations/import`, {
    method: "POST", body: { since: start, resource, page },
  });

  // Cross-repository contract coverage runs when the Studio build and Subathon checkout are available.
  it.skipIf(!existsSync(new URL("../../../osc-flow-studio/packages/flow-engine/dist/index.js", import.meta.url)) ||
    !existsSync(new URL("../../../catopanda-subathon/plugin/index.mjs", import.meta.url)))
  ("recovers a failed real flow through dashboard WebSocket and confirms only committed accounting", async () => {
    const [{ default: livepix }, { default: subathon }, { context }, { FlowEngine }, { readFile }] = await Promise.all([
      import(new URL("../../plugin/index.mjs", import.meta.url).href),
      import(new URL("../../../catopanda-subathon/plugin/index.mjs", import.meta.url).href),
      import(new URL("../../tests/helpers/dashboard.mjs", import.meta.url).href),
      import(new URL("../../../osc-flow-studio/packages/flow-engine/dist/index.js", import.meta.url).href),
      import("node:fs/promises"),
    ]);
    const s = await setup();
    const source = context({ baseUrl: h.base, apiToken: s.token, startAt: since });
    const target = context({ port: 0, initialTimerSeconds: 3600, donateSecondsPerReal: 60, warningThresholds: [] });
    const manifest = JSON.parse(await readFile(new URL("../../../catopanda-subathon/plugin/manifest.json", import.meta.url), "utf8"));
    const flow = manifest.templates.find((entry: { id: string }) => entry.id === "catopanda-subathon-livepix").flow;
    let failAccounting = true;
    const executions: Array<Promise<{ errors: unknown[] }>> = [];
    source.ctx.emitTrigger = (_kind: string, metadata: Record<string, unknown>) => {
      executions.push(new FlowEngine().execute({ ...structuredClone(flow), enabled: true }, {
        osc: {}, variables: {}, nodeOutputStore: {}, entryNodeId: "livepix-donation", triggerNodeId: "livepix-donation",
        pluginConfigs: { livepix: { enabled: true }, "catopanda-subathon": { enabled: true } },
        trigger: { integration: "livepix", kind: "donation", triggeredAt: new Date().toISOString(), metadata },
        executePluginAction: async ({ nodeType, data }: { nodeType: string; data: Record<string, unknown> }) => {
          const parts = nodeType.split(".");
          if (parts[2] === "catopanda-subathon" && failAccounting) throw new Error("Test flow failure");
          return (parts[2] === "livepix" ? source : target).actions.get(parts[3])(data);
        },
      }));
    };
    try {
      await subathon.activate(target.ctx);
      h.livepix.messages.set("lost", message("lost", "LOST", { amount: 500 }));
      h.livepix.messages.set("before-start", message("before-start", "BEFORE", { createdAt: "2026-09-20T12:00:00Z" }));
      await importPage(s, 1, "messages", "2026-09-20T00:00:00Z");
      await livepix.activate(source.ctx);
      await source.actions.get("poll-now")({});
      await until(() => executions.length === 1 && h.hub.count(s.id) === 1);
      expect((await executions[0]!).errors.length).toBeGreaterThan(0);
      const donation = await h.db.donation.findUniqueOrThrow({ where: { webhookId_key: { webhookId: s.id, key: "LOST" } } });
      expect(donation.accountedAt).toBeNull();
      expect((await target.actions.get("get-state")({})).totals.donate).toBe(0);
      failAccounting = false;
      const replay = () => s.browser.request(`/api/webhooks/${s.id}/donations/${donation.id}/resend`, { method: "POST" });
      expect((await replay()).status).toBe(200);
      await until(() => executions.length === 2);
      expect((await executions[1]!).errors).toEqual([]);
      expect((await h.db.donation.findUniqueOrThrow({ where: { id: donation.id } })).accountedAt).not.toBeNull();
      const recover = await s.browser.request(`/api/webhooks/${s.id}/donations/recover`, { method: "POST" });
      expect(recover.status).toBe(200);
      await until(() => executions.length === 3);
      expect((await executions[2]!).errors).toEqual([]);
      const state = await target.actions.get("get-state")({});
      expect(state.totals.donate).toBe(500);
      expect(state.totals.addedSeconds).toBe(300);
      expect(state.timer.remainingSeconds).toBe(3900);
      const before = await h.db.donation.findUniqueOrThrow({ where: { webhookId_key: { webhookId: s.id, key: "BEFORE" } } });
      expect(before.accountedAt).toBeNull();
    } finally { await livepix.deactivate(); await Promise.allSettled(executions); await subathon.deactivate(); }
  });

  it("imports all pages without a webhook and preserves dates and payment/message identity", async () => {
    const s = await setup();
    for (let i = 0; i < 103; i++) h.livepix.messages.set(`history-${i}`, message(`history-${i}`, `H${i}`, { createdAt: since }));
    h.livepix.messages.set("old", message("old", "OLD", { createdAt: "2026-09-21T11:59:59.999Z" }));
    h.livepix.messages.set("invalid", message("invalid", "INVALID", { createdAt: undefined }));
    const first = await importPage(s, 1);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ fetched: 100, imported: 98, excluded: 1, invalid: 1, hasMore: true });
    expect((await importPage(s, 2)).body).toMatchObject({ fetched: 5, imported: 5, hasMore: true });
    expect((await importPage(s, 3)).body).toMatchObject({ fetched: 0, hasMore: false });
    expect(h.livepix.pages).toEqual([1, 2, 3].map((page) => ({ resource: "messages", page, limit: 100 })));
    expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(103);
    expect(await h.db.delivery.count({ where: { webhookId: s.id } })).toBe(0);
    h.livepix.payments.set("p1", message("p1", "H1", { createdAt: since }));
    expect((await importPage(s, 1, "payments")).body).toMatchObject({ imported: 0, existing: 1 });
    expect((await importPage(s, 1)).body).toMatchObject({ imported: 0, existing: 98 });
    const search = await s.browser.request(`/api/webhooks/${s.id}/donations?search=H102&since=${since}`);
    expect(search.body.donations).toHaveLength(1);
    expect(search.body.donations[0]).toMatchObject({ id: "H102", accountedAt: null, resendCount: 0 });
  });

  it("retains imported pages across a provider failure and rejects invalid date requests", async () => {
    const s = await setup();
    h.livepix.messages.set("kept", message("kept", "KEPT"));
    expect((await importPage(s, 1)).body.imported).toBe(1);
    h.livepix.failWith = 503;
    expect((await importPage(s, 2)).status).toBe(502);
    expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(1);
    h.livepix.failWith = null;
    expect((await importPage(s, 1)).body.existing).toBe(1);
    expect((await importPage(s, 0)).status).toBe(400);
    expect((await importPage(s, 1, "messages", "not-a-date")).status).toBe(400);
    expect((await importPage(s, 1, "messages", "2026-02-30T00:00:00Z")).status).toBe(400);
  });

  it("resends the original donation with a new request ID and never treats transport as accounting", async () => {
    const s = await setup();
    h.livepix.messages.set("retry", message("retry", "RETRY"));
    await importPage(s, 1);
    const row = await h.db.donation.findFirstOrThrow({ where: { webhookId: s.id } });
    const url = `/api/webhooks/${s.id}/donations/${row.id}/resend`;
    expect((await s.browser.request(url, { method: "POST" })).body.error).toBe("plugin_offline");
    const ws = openSocket(s.urls.websocketUrl, s.token);
    await ws.next("hello");
    try {
      expect((await s.browser.request(url, { method: "POST" })).body).toEqual({ ok: true, sent: 1 });
      const first = await ws.next("donation.replay");
      expect(first.donation).toMatchObject({ id: "RETRY", seq: row.seq.toString(), amount: 1000 });
      await s.browser.request(url, { method: "POST" });
      expect((await ws.next("donation.replay")).requestId).not.toBe(first.requestId);
      const saved = await h.db.donation.findUniqueOrThrow({ where: { id: row.id } });
      expect(saved.resendCount).toBe(2);
      expect(saved.lastResentAt).not.toBeNull();
      expect(saved.accountedAt).toBeNull();
      expect(await h.db.donation.count({ where: { webhookId: s.id } })).toBe(1);
      expect((await s.browser.request(`/api/webhooks/${s.id}/donations/recover`, { method: "POST" })).body.sent).toBe(1);
      expect((await ws.next("donations.recover")).requestId).toBeTypeOf("string");
    } finally { ws.socket.close(); }
  });

  it("accepts idempotent flow receipts only for the token's webhook", async () => {
    const s = await setup(), other = await setup();
    h.livepix.messages.set("receipt", message("receipt", "RECEIPT"));
    await importPage(s, 1);
    const acknowledge = (owner: Setup, token = owner.token, eventKey = "livepix:donation:RECEIPT") => fetch(`${owner.urls.apiUrl}/accounted`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ eventKey }),
    });
    expect((await acknowledge(s, other.token)).status).toBe(401);
    expect((await acknowledge(other)).status).toBe(404);
    expect((await acknowledge(s, s.token, "wrong")).status).toBe(400);
    expect((await acknowledge(s)).status).toBe(200);
    const first = await h.db.donation.findFirstOrThrow({ where: { webhookId: s.id } });
    expect(first.accountedAt).not.toBeNull();
    expect((await acknowledge(s)).status).toBe(200);
    expect((await h.db.donation.findUniqueOrThrow({ where: { id: first.id } })).accountedAt).toEqual(first.accountedAt);
    const list = await s.browser.request(`/api/webhooks/${s.id}/donations`);
    expect(list.body.donations[0].accountedAt).toBe(first.accountedAt!.toISOString());
    await s.browser.request(`/api/webhooks/${s.id}`, { method: "PATCH", body: { active: false } });
    expect((await acknowledge(s)).status).toBe(403);
  });

  it("isolates history and resend actions by owner and webhook, including inactive webhooks", async () => {
    const s = await setup(), other = await setup();
    h.livepix.messages.set("scoped", message("scoped", "SCOPED"));
    await importPage(s, 1);
    const row = await h.db.donation.findFirstOrThrow({ where: { webhookId: s.id } });
    for (const path of ["import", "recover", `${row.id}/resend`]) {
      expect((await other.browser.request(`/api/webhooks/${s.id}/donations/${path}`, { method: "POST" })).status).toBe(404);
    }
    expect((await other.browser.request(`/api/webhooks/${other.id}/donations/${row.id}/resend`, { method: "POST" })).status).toBe(404);
    expect((await s.browser.request(`/api/webhooks/${s.id}/donations/recover`, { method: "POST" })).body.error).toBe("plugin_offline");
    await s.browser.request(`/api/webhooks/${s.id}`, { method: "PATCH", body: { active: false } });
    for (const path of ["import", "recover", `${row.id}/resend`]) {
      expect((await s.browser.request(`/api/webhooks/${s.id}/donations/${path}`, { method: "POST" })).body.error).toBe("webhook_inactive");
    }
  });
});

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
