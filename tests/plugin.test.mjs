import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import plugin, { connectWebSocket, parseStartAt, webhookIdFromToken } from "../plugin/index.mjs";

const WEBHOOK = "Wh00kIdForTests0000000AB";
const TOKEN = `olp_${WEBHOOK}_s3cretPartOfTheToken`;
const START = "2026-09-21T12:00:00.000Z";

/**
 * A dashboard that behaves like the real one on the wire: the donations API with
 * `since`/`after`/`limit`, and the WebSocket that pushes new donations.
 */
async function fakeDashboard({ rejectSocket = 0, rejectApi = 0 } = {}) {
  const donations = [];
  const sockets = new Set();
  const requests = [];
  let seq = 0;
  const state = { rejectSocket, rejectApi, authorization: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname + url.search);
    state.authorization.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer " + TOKEN) return reply(res, 401, { error: "unauthorized" });
    if (state.rejectApi) return reply(res, state.rejectApi, { error: "down" });
    if (url.pathname !== `/${WEBHOOK}/api/donations`) return reply(res, 404, { error: "not_found" });
    const since = Date.parse(url.searchParams.get("since"));
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const matching = donations.filter((d) => Date.parse(d.occurredAt) >= since && Number(d.seq) > after);
    const page = matching.slice(0, limit);
    reply(res, 200, {
      donations: page,
      nextAfter: page.length ? page[page.length - 1].seq : url.searchParams.get("after"),
      hasMore: matching.length > limit,
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== "Bearer " + TOKEN) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (state.rejectSocket) {
      socket.end(`HTTP/1.1 ${state.rejectSocket} Nope\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: "hello", webhook: { id: WEBHOOK } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    requests,
    sockets,
    state,
    /** Stores a donation; `push` also sends it down every open socket, like the real processor. */
    add(overrides = {}, { push = false } = {}) {
      seq += 1;
      const donation = {
        id: "E" + seq,
        seq: String(seq),
        amount: 500,
        currency: "BRL",
        username: "Ana",
        message: "vai!",
        hasMessage: true,
        flagged: false,
        livepixId: "lp" + seq,
        proof: "E" + seq,
        reference: "r" + seq,
        source: "message",
        occurredAt: "2026-09-21T13:00:00.000Z",
        receivedAt: "2026-09-21T13:00:01.000Z",
        ...overrides,
      };
      donations.push(donation);
      if (push) for (const ws of sockets) ws.send(JSON.stringify({ type: "donation", donation }));
      return donation;
    },
    dropSockets(code = 1011) {
      for (const ws of sockets) ws.close(code, "test");
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function context(overrides = {}, vault = new Map()) {
  const controller = new AbortController();
  const actions = new Map();
  const triggers = [];
  const statuses = [];
  const logs = [];
  const config = {
    enabled: true,
    baseUrl: "http://127.0.0.1:1",
    apiToken: TOKEN,
    startAt: START,
    pollSeconds: 2,
    currency: "BRL",
    ...overrides,
  };
  return {
    controller,
    actions,
    triggers,
    statuses,
    logs,
    vault,
    ctx: {
      signal: controller.signal,
      config: { get: async () => config },
      secrets: {
        get: async (key) => vault.get(key) ?? null,
        set: async (key, value) => { vault.set(key, value); },
        delete: async (key) => { vault.delete(key); },
      },
      registerAction: (name, handler) => actions.set(name, handler),
      emitTrigger: (name, payload) => triggers.push({ name, payload }),
      setStatus: (status) => statuses.push(status),
      setResource: () => {},
      onFlowsChanged: () => {},
      log: {
        info: (message) => logs.push("info " + message),
        warn: (message) => logs.push("warn " + message),
        error: (message) => logs.push("error " + message),
      },
    },
  };
}

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ids = (fixture) => fixture.triggers.map((t) => t.payload.eventKey.replace("livepix:donation:", ""));
const lastStatus = (fixture) => fixture.statuses[fixture.statuses.length - 1];

test("reads the subathon start in the formats the field accepts, in local time", () => {
  assert.equal(parseStartAt("2026-09-21 18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("2026-09-21T18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("21/09/2026 18:30"), new Date(2026, 8, 21, 18, 30).getTime());
  assert.equal(parseStartAt("21/09/2026"), new Date(2026, 8, 21).getTime());
  assert.equal(parseStartAt("2026-09-21T15:00:00.000Z"), Date.UTC(2026, 8, 21, 15));
  assert.ok(Number.isNaN(parseStartAt("31/02/2026 10:00")));
  assert.ok(Number.isNaN(parseStartAt("amanhã")));
  assert.ok(Number.isNaN(parseStartAt("")));
});

test("the token names its webhook", () => {
  assert.equal(webhookIdFromToken(TOKEN), WEBHOOK);
  assert.equal(webhookIdFromToken("olp_abc_x"), "");
  assert.equal(webhookIdFromToken("not-a-token"), "");
});

test("fires every donation since the subathon start once, oldest first, with the 1.x payload", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "BEFORE", occurredAt: "2026-09-21T11:59:59.000Z" });
  dashboard.add({ id: "LATE", occurredAt: "2026-09-21T14:00:00.000Z" });
  dashboard.add({ id: "EARLY", occurredAt: "2026-09-21T12:30:00.000Z", username: "", message: "" });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 2);
    assert.deepEqual(ids(fixture), ["EARLY", "LATE"]);
    const [first, second] = fixture.triggers;
    assert.equal(first.name, "donation");
    assert.equal(first.payload.hasMessage, false);
    assert.deepEqual(second.payload, {
      amount: 500,
      amountFormatted: "R$ 5,00",
      currency: "BRL",
      username: "Ana",
      message: "vai!",
      hasMessage: true,
      flagged: false,
      id: "lp2",
      proof: "E2",
      reference: "r2",
      createdAt: "2026-09-21T14:00:00.000Z",
      eventKey: "livepix:donation:LATE",
      actorId: "Ana",
      actorDisplayName: "Ana",
    });
    assert.ok(dashboard.requests.some((r) => r.includes("since=2026-09-21T12%3A00%3A00.000Z")));
    assert.ok(dashboard.state.authorization.every((value) => value === "Bearer " + TOKEN));
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("a donation pushed over the socket fires at once and never again from the API", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1 && lastStatus(fixture)?.connectionState === "tempo real (WebSocket)");
    dashboard.add({ id: "LIVE" }, { push: true });
    await until(() => fixture.triggers.length === 1);
    const sync = await fixture.actions.get("poll-now")({});
    assert.equal(sync.ok, true);
    assert.equal(sync.fetched, 1);
    assert.equal(sync.emitted, 0);
    assert.deepEqual(ids(fixture), ["LIVE"]);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.transport, "websocket");
    assert.equal(status.seen, 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("after a restart it fires only what arrived while it was off", async () => {
  const dashboard = await fakeDashboard();
  const vault = new Map();
  dashboard.add({ id: "A" });
  dashboard.add({ id: "B" });
  const first = context({ baseUrl: dashboard.baseUrl }, vault);
  try {
    await plugin.activate(first.ctx);
    await until(() => first.triggers.length === 2);
  } finally {
    await plugin.deactivate();
  }
  // Studio closed: the dashboard keeps receiving donations.
  dashboard.add({ id: "C" });
  dashboard.add({ id: "D" });
  const second = context({ baseUrl: dashboard.baseUrl }, vault);
  try {
    await plugin.activate(second.ctx);
    await until(() => second.triggers.length === 2);
    await second.actions.get("poll-now")({});
    assert.deepEqual(ids(second), ["C", "D"]);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("without the socket it polls the API at the configured interval", async () => {
  const dashboard = await fakeDashboard({ rejectSocket: 503 });
  const fixture = context({ baseUrl: dashboard.baseUrl, pollSeconds: 2 });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => lastStatus(fixture)?.connectionState?.startsWith("consultando a API a cada 2 s"));
    assert.equal(lastStatus(fixture).health, "degraded");
    dashboard.add({ id: "POLLED" });
    await until(() => fixture.triggers.length === 1, 4000);
    assert.deepEqual(ids(fixture), ["POLLED"]);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.transport, "polling");
    // The next poll continues after the last sequence number instead of rereading everything.
    await until(() => dashboard.requests.some((r) => r.includes("after=1")), 4000);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("reconnects after the socket drops and reads what it missed", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, pollSeconds: 300 });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1);
    dashboard.state.rejectSocket = 503;
    dashboard.dropSockets();
    await until(() => dashboard.sockets.size === 0);
    dashboard.add({ id: "MISSED" }, { push: true });
    dashboard.state.rejectSocket = 0;
    // First retry comes after one second; the reconnect runs a full sync from the start.
    await until(() => fixture.triggers.length === 1, 5000);
    assert.deepEqual(ids(fixture), ["MISSED"]);
    assert.equal(dashboard.sockets.size, 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("ignores other currencies and zero amounts without firing them later", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "USD", currency: "USD" });
  dashboard.add({ id: "ZERO", amount: 0 });
  dashboard.add({ id: "OK" });
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 1);
    await fixture.actions.get("poll-now")({});
    assert.deepEqual(ids(fixture), ["OK"]);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("without a subathon start it counts from the first activation, never the history", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "OLD", occurredAt: new Date(Date.now() - 60_000).toISOString() });
  const vault = new Map();
  const fixture = context({ baseUrl: dashboard.baseUrl, startAt: "" }, vault);
  try {
    await plugin.activate(fixture.ctx);
    const sync = await fixture.actions.get("poll-now")({});
    assert.equal(sync.ok, true);
    dashboard.add({ id: "NEW", occurredAt: new Date(Date.now() + 1000).toISOString() }, { push: true });
    await until(() => fixture.triggers.length === 1);
    assert.deepEqual(ids(fixture), ["NEW"]);
    const saved = JSON.parse(vault.get("livepix-state-v1"));
    assert.ok(saved.autoStartAt > 0, "the automatic start survives a restart");
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("donations counted by 1.2.0 stay counted after the update", async () => {
  const dashboard = await fakeDashboard();
  dashboard.add({ id: "E-OLD", occurredAt: new Date(Date.now() + 1000).toISOString() });
  dashboard.add({ id: "E-NEW", occurredAt: new Date(Date.now() + 2000).toISOString() });
  const vault = new Map([["livepix-state-v1", JSON.stringify({ version: 2, initialized: true, seen: ["livepix:E-OLD"], lastPollAt: "" })]]);
  const fixture = context({ baseUrl: dashboard.baseUrl, startAt: "2026-01-01 00:00" }, vault);
  try {
    await plugin.activate(fixture.ctx);
    await until(() => fixture.triggers.length === 1);
    await fixture.actions.get("poll-now")({});
    assert.deepEqual(ids(fixture), ["E-NEW"]);
    assert.equal(JSON.parse(vault.get("livepix-state-v1")).version, 3);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("a refused token degrades the status with the reason", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, apiToken: `olp_${WEBHOOK}_wrong` });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => (lastStatus(fixture)?.errors ?? []).some((e) => e.includes("Token recusado")));
    assert.equal(lastStatus(fixture).health, "degraded");
    assert.ok(lastStatus(fixture).errors.some((e) => e.includes("token recusado")));
    assert.equal(fixture.triggers.length, 0);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("an incomplete configuration waits instead of connecting", async () => {
  for (const [overrides, reason] of [
    [{ apiToken: "" }, /Informe o token/],
    [{ apiToken: "abc" }, /formato/],
    [{ startAt: "ontem" }, /Início do subathon inválido/],
    [{ baseUrl: "http://livepix.example.com" }, /https/],
  ]) {
    const fixture = context(overrides);
    try {
      await plugin.activate(fixture.ctx);
      assert.equal(lastStatus(fixture).health, "degraded");
      assert.match(lastStatus(fixture).errors[0], reason);
      const action = await fixture.actions.get("poll-now")({});
      assert.equal(action.ok, false);
    } finally {
      await plugin.deactivate();
    }
  }
});

test("disabled, it neither connects nor polls", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl, enabled: false });
  try {
    await plugin.activate(fixture.ctx);
    assert.equal(lastStatus(fixture).connectionState, "desativado");
    assert.equal((await fixture.actions.get("poll-now")({})).ok, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dashboard.requests.length, 0);
    assert.equal(dashboard.sockets.size, 0);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("the host abort signal stops the socket and the timers, and it can activate again", async () => {
  const dashboard = await fakeDashboard();
  const fixture = context({ baseUrl: dashboard.baseUrl });
  try {
    await plugin.activate(fixture.ctx);
    await until(() => dashboard.sockets.size === 1);
    fixture.controller.abort();
    await plugin.deactivate();
    await until(() => dashboard.sockets.size === 0);
    const again = context({ baseUrl: dashboard.baseUrl });
    await plugin.activate(again.ctx);
    await until(() => dashboard.sockets.size === 1);
  } finally {
    await plugin.deactivate();
    await dashboard.close();
  }
});

test("the WebSocket client reads fragmented, large and ping frames", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const big = "x".repeat(70_000);
  const received = [];
  let pongs = 0;
  wss.on("connection", (ws) => {
    ws.on("pong", () => { pongs += 1; });
    ws.on("message", (data) => ws.send("echo:" + String(data)));
    ws.ping("hi");
    ws.send("small");
    ws.send(big);
    ws.send("frag", { fin: false });
    ws.send("mented", { fin: true });
  });
  let closed;
  const done = new Promise((resolve) => { closed = resolve; });
  const client = connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, {}, {
    onOpen: () => client.send("hello"),
    onMessage: (text) => received.push(text),
    onClose: (code) => closed(code),
  });
  try {
    await until(() => received.length === 4);
    assert.deepEqual(received.map((text) => text.length > 100 ? `big:${text.length}` : text), ["small", "big:70000", "fragmented", "echo:hello"]);
    await until(() => pongs === 1);
    client.close(1000);
    assert.equal(await done, 1000);
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the WebSocket client maps a refused handshake to a close code", async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const code = await new Promise((resolve) => {
      connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, {}, { onMessage: () => {}, onClose: resolve });
    });
    assert.equal(code, 4001);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
