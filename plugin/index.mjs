/**
 * LivePix for OSC Flow Studio.
 *
 * Polls the LivePix v2 API with OAuth2 client credentials and turns every new
 * donation into one trigger. No public webhook, no tunnel: everything runs from
 * the user's machine. The client secret lives in the app's vault and only ever
 * travels to oauth.livepix.gg.
 *
 * One donation is one event. /v2/payments is the canonical list and
 * /v2/messages only carries the donations that came with text, so the two are
 * merged by proof before anything fires. Reading them as separate streams was
 * the 1.0.0 mistake: a donation with a message fired twice and a flow that
 * credited both counted it twice.
 */

const STATE_KEY = "livepix-state-v1";
const STATE_VERSION = 2;
const TOKEN_URL = "https://oauth.livepix.gg/oauth2/token";
const API_BASE = "https://api.livepix.gg/v2/";
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_POLL = 3;
const MAX_SEEN_KEYS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 300_000;

let activeRuntime = null;

function asNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asSecret(value) {
  return typeof value === "string" && value !== "***" ? value.trim() : "";
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConfig(raw) {
  return {
    enabled: raw.enabled !== false,
    readMessages: raw.readMessages !== false,
    pollSeconds: Math.round(asNumber(raw.pollSeconds, 30, 15, 300)),
    currency: asText(raw.currency, "BRL").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) || "BRL",
    clientId: asText(raw.clientId, ""),
    clientSecret: asSecret(raw.clientSecret),
    processExisting: raw.processExisting === true,
  };
}

function scopeFor(config) {
  return config.readMessages ? "payments:read messages:read" : "payments:read";
}

function initialState() {
  return { version: STATE_VERSION, initialized: false, seen: [], lastPollAt: "", forceBaseline: false };
}

function hydrateState(raw, log) {
  if (!raw) return initialState();
  try {
    const parsed = JSON.parse(raw);
    const next = initialState();
    if (Number(parsed.version) !== STATE_VERSION) {
      // 1.0.0 keyed the ledger per resource (payments:<id>, messages:<id>);
      // 1.1.0 keys one donation by proof. Replaying the old keys against the
      // new format would re-fire every past donation, so the next poll takes a
      // fresh baseline instead and nothing is credited twice.
      log.warn("estado da versão anterior encontrado; a próxima consulta refaz a linha de base sem disparar gatilhos");
      next.forceBaseline = true;
      return next;
    }
    next.initialized = parsed.initialized === true;
    next.seen = Array.isArray(parsed.seen)
      ? parsed.seen.filter((key) => typeof key === "string").slice(-MAX_SEEN_KEYS)
      : [];
    next.lastPollAt = typeof parsed.lastPollAt === "string" ? parsed.lastPollAt : "";
    return next;
  } catch (error) {
    log.warn("estado persistido inválido; começando do zero: " + describe(error));
    return initialState();
  }
}

async function persist(runtime) {
  try {
    await runtime.ctx.secrets.set(STATE_KEY, JSON.stringify(runtime.state));
  } catch (error) {
    runtime.ctx.log.warn("não foi possível persistir o estado: " + describe(error));
  }
}

/** One donation, however it was read. Proof is the id LivePix shares between the two lists. */
function donationKey(item) {
  return asText(item && item.proof, "")
    || asText(item && item.reference, "")
    || asText(item && item.id, "");
}

function formatAmount(cents, currency) {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
  } catch {
    return value.toFixed(2) + " " + currency;
  }
}

function markSeen(runtime, key) {
  runtime.seenSet.add(key);
  runtime.state.seen.push(key);
  if (runtime.state.seen.length > MAX_SEEN_KEYS) {
    const dropped = runtime.state.seen.splice(0, runtime.state.seen.length - MAX_SEEN_KEYS);
    for (const old of dropped) runtime.seenSet.delete(old);
  }
}

async function getToken(runtime) {
  if (runtime.token && Date.now() < runtime.token.expiresAt - 60_000) {
    return runtime.token.value;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: runtime.config.clientId,
    client_secret: runtime.config.clientSecret,
    scope: scopeFor(runtime.config),
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw new Error(
      "OAuth LivePix respondeu HTTP " + String(response.status)
      + " (confira Client ID, Client Secret e se o aplicativo tem os escopos "
      + scopeFor(runtime.config) + ")",
    );
  }
  const payload = await response.json();
  runtime.controller.signal.throwIfAborted();
  if (!payload || typeof payload.access_token !== "string") {
    throw new Error("OAuth LivePix não devolveu access_token");
  }
  runtime.token = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000,
  };
  return runtime.token.value;
}

class RateLimitedError extends Error {
  constructor(resource) {
    super("LivePix limitou as requisições de " + resource + " (HTTP 429)");
    this.name = "RateLimitedError";
  }
}

async function fetchPage(runtime, resource, page, retry = true) {
  const token = await getToken(runtime);
  runtime.controller.signal.throwIfAborted();
  const url = new URL(API_BASE + resource);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_LIMIT));
  url.searchParams.set("currency", runtime.config.currency);
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
    signal: AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (response.status === 401 && retry) {
    runtime.token = null;
    return fetchPage(runtime, resource, page, false);
  }
  if (response.status === 429) {
    throw new RateLimitedError(resource);
  }
  if (!response.ok) {
    throw new Error("LivePix " + resource + " respondeu HTTP " + String(response.status));
  }
  const payload = await response.json();
  runtime.controller.signal.throwIfAborted();
  return Array.isArray(payload && payload.data) ? payload.data : [];
}

/**
 * Reads pages newest-first until a page brings nothing unseen. A baseline poll
 * reads a single page: it only needs to learn what already exists.
 */
async function fetchResource(runtime, resource, singlePage) {
  const items = [];
  for (let page = 1; page <= (singlePage ? 1 : MAX_PAGES_PER_POLL); page += 1) {
    const data = await fetchPage(runtime, resource, page);
    let unseen = 0;
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const key = donationKey(item);
      if (!key) continue;
      items.push(item);
      if (!runtime.seenSet.has("livepix:" + key)) unseen += 1;
    }
    if (data.length < PAGE_LIMIT || unseen === 0) break;
  }
  return items;
}

function isValidItem(runtime, item) {
  return Number(item.amount) > 0
    && String(item.currency || "").toUpperCase() === runtime.config.currency;
}

function buildPayload(runtime, donation) {
  const amount = Math.round(Number(donation.amount));
  const username = asText(donation.username, "");
  const message = asText(donation.message, "");
  return {
    amount,
    amountFormatted: formatAmount(amount, runtime.config.currency),
    currency: runtime.config.currency,
    username,
    message,
    hasMessage: message.length > 0,
    flagged: donation.flagged === true,
    id: asText(donation.id, ""),
    proof: asText(donation.proof, ""),
    reference: asText(donation.reference, ""),
    createdAt: asText(donation.createdAt, new Date().toISOString()),
    eventKey: "livepix:donation:" + donationKey(donation),
    actorId: username,
    actorDisplayName: username,
  };
}

/**
 * Payments are the canonical list; messages only add the name and the text of
 * the donations that carried one. A message with no payment in this window
 * still counts, so nothing is lost when the two lists disagree for a moment.
 */
function mergeDonations(payments, messages) {
  const byKey = new Map();
  for (const payment of payments) {
    byKey.set(donationKey(payment), { ...payment });
  }
  for (const message of messages) {
    const key = donationKey(message);
    const existing = byKey.get(key);
    if (existing) {
      existing.username = message.username;
      existing.message = message.message;
      existing.flagged = message.flagged;
    } else {
      byKey.set(key, { ...message });
    }
  }
  return [...byKey.values()];
}

function poll(runtime, reason) {
  if (runtime.stopped || !runtime.config.enabled) {
    return Promise.resolve({ ok: false, fetched: 0, emitted: 0, error: "plugin desativado" });
  }
  if (runtime.pollPromise) return Promise.resolve({ ok: true, fetched: 0, emitted: 0, skipped: true });
  runtime.pollPromise = runPoll(runtime, reason).finally(() => { runtime.pollPromise = null; });
  return runtime.pollPromise;
}

async function runPoll(runtime, reason) {
  let fetched = 0;
  let emitted = 0;
  try {
    const baseline = runtime.state.forceBaseline
      || (!runtime.state.initialized && !runtime.config.processExisting);
    const payments = await fetchResource(runtime, "payments", baseline);
    const messages = runtime.config.readMessages
      ? await fetchResource(runtime, "messages", baseline)
      : [];
    const donations = mergeDonations(payments, messages);
    fetched = donations.length;

    const pending = [];
    for (const donation of donations) {
      const key = "livepix:" + donationKey(donation);
      if (runtime.seenSet.has(key)) continue;
      markSeen(runtime, key);
      if (baseline || !isValidItem(runtime, donation)) continue;
      pending.push(donation);
    }
    pending.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
    runtime.state.initialized = true;
    runtime.state.forceBaseline = false;
    runtime.state.lastPollAt = new Date().toISOString();
    runtime.lastError = "";
    runtime.connected = true;
    runtime.backoffMs = 0;
    await persist(runtime);
    runtime.controller.signal.throwIfAborted();
    for (const donation of pending) {
      runtime.ctx.emitTrigger("donation", buildPayload(runtime, donation));
      emitted += 1;
      runtime.emittedSinceStart += 1;
    }
    if (baseline) {
      runtime.ctx.log.info(
        "primeira consulta: " + String(fetched) + " doação(ões) do histórico marcadas como vistas, nenhum gatilho disparado",
      );
    } else if (emitted > 0) {
      runtime.ctx.log.info(String(emitted) + " gatilho(s) disparado(s) (" + reason + ")");
    }
    publishStatus(runtime);
    return { ok: true, fetched, emitted };
  } catch (error) {
    if (runtime.stopped) return { ok: false, fetched, emitted, error: "consulta cancelada" };
    runtime.lastError = describe(error);
    runtime.connected = false;
    if (error instanceof RateLimitedError) {
      runtime.backoffMs = Math.min(
        MAX_BACKOFF_MS,
        Math.max(runtime.config.pollSeconds * 1000 * 2, runtime.backoffMs * 2),
      );
    }
    runtime.ctx.log.warn("consulta falhou: " + runtime.lastError);
    publishStatus(runtime);
    return { ok: false, fetched, emitted, error: runtime.lastError };
  }
}

function publishStatus(runtime) {
  if (runtime.stopped) return;
  if (!runtime.config.clientId || !runtime.config.clientSecret) {
    runtime.ctx.setStatus({
      health: "degraded",
      connectionState: "aguardando credenciais",
      errors: ["Informe o Client ID e o Client Secret na aba Credenciais."],
    });
    return;
  }
  if (runtime.connected) {
    const at = runtime.state.lastPollAt ? new Date(runtime.state.lastPollAt) : null;
    const clock = at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "";
    runtime.ctx.setStatus({
      health: "healthy",
      connectionState: clock ? "conectado; última consulta " + clock : "conectado",
    });
    return;
  }
  runtime.ctx.setStatus({
    health: runtime.lastError ? "degraded" : "unknown",
    connectionState: runtime.lastError ? "com erro" : "conectando",
    ...(runtime.lastError ? { errors: [runtime.lastError] } : {}),
  });
}

function schedule(runtime) {
  if (runtime.stopped) return;
  const delay = runtime.backoffMs > 0 ? runtime.backoffMs : runtime.config.pollSeconds * 1000;
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void poll(runtime, "intervalo").finally(() => schedule(runtime));
  }, delay);
}

function statusSnapshot(runtime) {
  return {
    connected: runtime.connected,
    lastPollAt: runtime.state.lastPollAt,
    lastError: runtime.lastError,
    seen: runtime.state.seen.length,
    emittedSinceStart: runtime.emittedSinceStart,
  };
}

function stopRuntime(runtime) {
  runtime.stopped = true;
  runtime.connected = false;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
  runtime.controller.abort();
}

export default {
  async activate(ctx) {
    if (activeRuntime) throw new Error("LivePix já está ativo");
    const config = normalizeConfig(await ctx.config.get());
    let persisted = null;
    try {
      persisted = await ctx.secrets.get(STATE_KEY);
    } catch {
      persisted = null;
    }
    const state = hydrateState(persisted, ctx.log);
    const runtime = {
      ctx,
      config,
      state,
      seenSet: new Set(state.seen),
      token: null,
      timer: null,
      pollPromise: null,
      controller: new AbortController(),
      stopped: false,
      backoffMs: 0,
      connected: false,
      lastError: "",
      emittedSinceStart: 0,
    };
    activeRuntime = runtime;
    runtime.onAbort = () => stopRuntime(runtime);
    ctx.signal?.addEventListener("abort", runtime.onAbort, { once: true });
    if (ctx.signal?.aborted) stopRuntime(runtime);
    ctx.registerAction("poll-now", async () => {
      if (!config.clientId || !config.clientSecret) {
        return { ok: false, fetched: 0, emitted: 0, error: "credenciais ausentes" };
      }
      return poll(runtime, "ação");
    });
    ctx.registerAction("status", async () => statusSnapshot(runtime));

    if (runtime.stopped) return;
    if (!config.enabled) {
      ctx.setStatus({ health: "healthy", connectionState: "desativado" });
      return;
    }
    publishStatus(runtime);
    if (!config.clientId || !config.clientSecret) {
      ctx.log.warn("LivePix ativado sem Client ID ou Client Secret; nada será consultado");
      return;
    }
    void poll(runtime, "ativação").finally(() => schedule(runtime));
  },

  async deactivate() {
    const runtime = activeRuntime;
    if (!runtime) return;
    stopRuntime(runtime);
    runtime.ctx.signal?.removeEventListener("abort", runtime.onAbort);
    await runtime.pollPromise;
    runtime.token = null;
    await persist(runtime);
    activeRuntime = null;
  },
};
