import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../plugin/index.mjs";

function context(overrides = {}, sharedSecrets = new Map()) {
  const controller = new AbortController();
  const actions = new Map();
  const triggers = [];
  const statuses = [];
  const logs = [];
  const config = {
    enabled: true,
    readMessages: true,
    pollSeconds: 15,
    currency: "BRL",
    clientId: "client",
    clientSecret: "secret",
    processExisting: false,
    ...overrides,
  };
  return {
    controller,
    actions,
    triggers,
    statuses,
    logs,
    ctx: {
      signal: controller.signal,
      config: { get: async () => config },
      secrets: {
        get: async (key) => sharedSecrets.get(key) || null,
        set: async (key, value) => { sharedSecrets.set(key, value); },
        delete: async (key) => { sharedSecrets.delete(key); },
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake LivePix: OAuth plus pages of payments and messages, newest first. */
function fakeLivePix({ payments = [], messages = [], tokenStatus = 200, rateLimited = false } = {}) {
  const calls = { token: 0, payments: 0, messages: 0 };
  const scopes = [];
  const install = () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://oauth.livepix.gg/oauth2/token") {
        calls.token += 1;
        assert.equal(init.method, "POST");
        const body = String(init.body);
        assert.match(body, /grant_type=client_credentials/);
        assert.match(body, /client_secret=secret/);
        scopes.push(new URLSearchParams(body).get("scope"));
        if (tokenStatus !== 200) return jsonResponse({ error: "invalid_client" }, tokenStatus);
        return jsonResponse({ access_token: "token", expires_in: 3600 });
      }
      const parsed = new URL(url);
      assert.equal(init.headers.authorization, "Bearer token");
      if (rateLimited) return jsonResponse({ error: "too many" }, 429);
      const page = Number(parsed.searchParams.get("page"));
      const limit = Number(parsed.searchParams.get("limit"));
      const isPayments = parsed.pathname.endsWith("/payments");
      calls[isPayments ? "payments" : "messages"] += 1;
      const list = isPayments ? payments : messages;
      return jsonResponse({ data: list.slice((page - 1) * limit, page * limit) });
    };
  };
  return { calls, scopes, install };
}

const nativeFetch = globalThis.fetch;

for (const phase of ["oauth", "payments", "body"]) {
  test(`SDK 0.5 cancels an in-flight ${phase} request and can reactivate`, { timeout: 3000 }, async () => {
    let started;
    const pending = new Promise((resolve) => { started = resolve; });
    let requestSignal;
    const fixture = context({ processExisting: true });
    const blocked = (signal) => new Promise((resolve, reject) => {
      requestSignal = signal;
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("oauth2/token")) {
        if (phase === "oauth") return blocked(init.signal);
        return jsonResponse({ access_token: "token", expires_in: 3600 });
      }
      if (phase === "body") return { ok: true, status: 200, json: () => blocked(init.signal) };
      return blocked(init.signal);
    };
    try {
      await plugin.activate(fixture.ctx);
      await pending;
      const statusCount = fixture.statuses.length;
      assert.equal((await fixture.actions.get("poll-now")({})).skipped, true);
      fixture.controller.abort();
      await plugin.deactivate();
      assert.equal(requestSignal.aborted, true);
      assert.equal(fixture.triggers.length, 0);
      assert.equal(fixture.statuses.length, statusCount, "shutdown must not report a connection failure");
      assert.equal(fixture.logs.length, 0);
      fakeLivePix({}).install();
      await plugin.activate(context({}).ctx);
    } finally {
      await plugin.deactivate();
      globalThis.fetch = nativeFetch;
    }
  });
}

test("deactivate aborts without a host signal and disabled actions do not poll", { timeout: 3000 }, async () => {
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  let requestSignal;
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    requestSignal = signal;
    started();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const fixture = context({});
  delete fixture.ctx.signal;
  try {
    await plugin.activate(fixture.ctx);
    await pending;
    await plugin.deactivate();
    assert.equal(requestSignal.aborted, true);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse({}); };
    const disabled = context({ enabled: false });
    await plugin.activate(disabled.ctx);
    assert.equal((await disabled.actions.get("poll-now")({})).ok, false);
    assert.equal(calls, 0);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("one donation is one trigger: payment and message merge instead of firing twice", async () => {
  const fake = fakeLivePix({
    payments: [
      { id: "pay-1", proof: "pix-1", amount: 1500, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" },
      { id: "pay-2", proof: "pix-2", amount: 500, currency: "BRL", createdAt: "2026-01-01T00:01:00Z" },
    ],
    messages: [
      { id: "msg-1", proof: "pix-1", username: "Panda", message: "vai time", amount: 1500, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" },
    ],
  });
  fake.install();
  const fixture = context({ processExisting: true });
  try {
    await plugin.activate(fixture.ctx);
    await wait(60);
    assert.match(fake.scopes[0], /payments:read messages:read/);
    assert.deepEqual(fixture.triggers.map((event) => event.name), ["donation", "donation"]);

    const withMessage = fixture.triggers[0].payload;
    assert.equal(withMessage.amount, 1500);
    assert.equal(withMessage.username, "Panda");
    assert.equal(withMessage.message, "vai time");
    assert.equal(withMessage.hasMessage, true);
    assert.equal(withMessage.actorDisplayName, "Panda");
    assert.equal(withMessage.eventKey, "livepix:donation:pix-1");

    const plain = fixture.triggers[1].payload;
    assert.equal(plain.amount, 500);
    assert.equal(plain.hasMessage, false);
    assert.equal(plain.username, "");
    assert.equal(plain.message, "");
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("first poll only marks history as seen; the next poll fires new donations once", async () => {
  const fake = fakeLivePix({
    payments: [
      { id: "old-1", proof: "p1", amount: 1000, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" },
    ],
  });
  fake.install();
  const secrets = new Map();
  const fixture = context({}, secrets);
  try {
    await plugin.activate(fixture.ctx);
    await wait(50);
    assert.equal(fixture.triggers.length, 0);

    const fresh = fakeLivePix({
      payments: [
        { id: "new-2", proof: "p3", amount: 2500, currency: "BRL", createdAt: "2026-01-02T00:00:10Z" },
        { id: "new-1", proof: "p2", amount: 500, currency: "BRL", createdAt: "2026-01-02T00:00:00Z" },
        { id: "old-1", proof: "p1", amount: 1000, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" },
        { id: "usd", proof: "p4", amount: 700, currency: "USD", createdAt: "2026-01-02T00:00:20Z" },
      ],
    });
    fresh.install();
    const result = await fixture.actions.get("poll-now")({});
    assert.equal(result.ok, true);
    assert.equal(result.emitted, 2);
    assert.deepEqual(
      fixture.triggers.map((event) => event.payload.amount),
      [500, 2500],
      "oldest first, foreign currency ignored",
    );
    assert.equal(fixture.triggers[0].payload.amountFormatted.replace(/ /g, " "), "R$ 5,00");

    const again = await fixture.actions.get("poll-now")({});
    assert.equal(again.emitted, 0);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.connected, true);
    assert.equal(status.emittedSinceStart, 2);
    assert.equal(fixture.statuses.at(-1).health, "healthy");
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }

  // The seen ledger survives a restart, so the same donations never fire twice.
  const fresh = fakeLivePix({
    payments: [
      { id: "new-2", proof: "p3", amount: 2500, currency: "BRL", createdAt: "2026-01-02T00:00:10Z" },
    ],
  });
  fresh.install();
  const second = context({}, secrets);
  try {
    await plugin.activate(second.ctx);
    await wait(50);
    assert.equal(second.triggers.length, 0);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("a message with no matching payment still fires exactly once", async () => {
  const fake = fakeLivePix({
    payments: [],
    messages: [
      { id: "msg-9", proof: "pix-9", username: "Solo", message: "oi", amount: 700, currency: "BRL", createdAt: "2026-01-03T00:00:00Z" },
    ],
  });
  fake.install();
  const fixture = context({ processExisting: true });
  try {
    await plugin.activate(fixture.ctx);
    await wait(60);
    assert.equal(fixture.triggers.length, 1);
    assert.equal(fixture.triggers[0].payload.username, "Solo");
    const again = await fixture.actions.get("poll-now")({});
    assert.equal(again.emitted, 0);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("messages off asks only for payments:read and never calls the messages endpoint", async () => {
  const fake = fakeLivePix({
    payments: [{ id: "pay-1", proof: "pix-1", amount: 900, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" }],
    messages: [{ id: "msg-1", proof: "pix-1", username: "Panda", message: "oi", amount: 900, currency: "BRL" }],
  });
  fake.install();
  const fixture = context({ readMessages: false, processExisting: true });
  try {
    await plugin.activate(fixture.ctx);
    await wait(60);
    assert.equal(fake.scopes[0], "payments:read");
    assert.equal(fake.calls.messages, 0);
    assert.equal(fixture.triggers.length, 1);
    assert.equal(fixture.triggers[0].payload.hasMessage, false);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("a ledger written by 1.0.0 re-baselines instead of replaying every donation", async () => {
  const secrets = new Map();
  secrets.set(
    "livepix-state-v1",
    JSON.stringify({ version: 1, initialized: true, seen: ["payments:old-1"], lastPollAt: "2026-01-01T00:00:00Z" }),
  );
  const fake = fakeLivePix({
    payments: [{ id: "old-1", proof: "p1", amount: 1000, currency: "BRL", createdAt: "2026-01-01T00:00:00Z" }],
  });
  fake.install();
  const fixture = context({ processExisting: true }, secrets);
  try {
    await plugin.activate(fixture.ctx);
    await wait(60);
    assert.equal(fixture.triggers.length, 0, "an upgrade must never credit a past donation again");
    assert.ok(fixture.logs.some((line) => line.includes("linha de base")));
    const after = await fixture.actions.get("poll-now")({});
    assert.equal(after.emitted, 0);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("bad credentials degrade the status and never crash activation", async () => {
  const fake = fakeLivePix({ tokenStatus: 401 });
  fake.install();
  const fixture = context({});
  try {
    await plugin.activate(fixture.ctx);
    await wait(50);
    const status = await fixture.actions.get("status")({});
    assert.equal(status.connected, false);
    assert.match(status.lastError, /HTTP 401/);
    assert.match(status.lastError, /payments:read/, "the message names the scopes the app needs");
    assert.equal(fixture.statuses.at(-1).health, "degraded");
    assert.ok(!fixture.logs.join("\n").includes("secret"));
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("missing credentials wait instead of polling", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  const fixture = context({ clientId: "", clientSecret: "***" });
  try {
    await plugin.activate(fixture.ctx);
    await wait(30);
    assert.equal(called, false);
    assert.equal(fixture.statuses.at(-1).connectionState, "aguardando credenciais");
    const result = await fixture.actions.get("poll-now")({});
    assert.equal(result.ok, false);
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});

test("a 429 answer backs off instead of hammering the API", async () => {
  const fake = fakeLivePix({ rateLimited: true });
  fake.install();
  const fixture = context({});
  try {
    await plugin.activate(fixture.ctx);
    await wait(50);
    const result = await fixture.actions.get("poll-now")({});
    assert.equal(result.ok, false);
    assert.match(result.error, /429/);
    assert.equal(fixture.statuses.at(-1).health, "degraded");
  } finally {
    await plugin.deactivate();
    globalThis.fetch = nativeFetch;
  }
});
