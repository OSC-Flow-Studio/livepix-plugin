import { serve, type ServerType } from "@hono/node-server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
// @ts-expect-error plain ESM script without declarations
import { startPglite } from "../scripts/pglite-server.mjs";
import { createApp } from "../server/src/app.js";
import { createAuth } from "../server/src/auth.js";
import { createSecretBox } from "../server/src/crypto.js";
import { createDb, type Db } from "../server/src/db.js";
import { createLivePixClient } from "../server/src/livepix/client.js";
import { createProcessor, type Processor } from "../server/src/processor.js";
import { RealtimeHub } from "../server/src/realtime.js";

export const LIVEPIX_API = "https://api.livepix.test/v2/";
export const LIVEPIX_TOKEN = "https://oauth.livepix.test/oauth2/token";

type Item = Record<string, unknown>;

/** A LivePix that answers OAuth and single-resource reads from in-memory maps. */
export class FakeLivePix {
  messages = new Map<string, Item>();
  payments = new Map<string, Item>();
  failWith: number | null = null;
  calls: string[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    this.calls.push(url.pathname);
    if (url.href === LIVEPIX_TOKEN) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("client_secret") !== "livepix-secret") return json({ error: "invalid_client" }, 401);
      return json({ access_token: "access", expires_in: 3600 });
    }
    if (this.failWith) return json({ error: "boom" }, this.failWith);
    const [, , resource, id] = url.pathname.split("/");
    const store = resource === "messages" ? this.messages : resource === "payments" ? this.payments : null;
    if (!store) return json({ error: "unknown" }, 404);
    if (id) {
      const item = store.get(decodeURIComponent(id));
      return item ? json({ data: item }) : json({ error: "not found" }, 404);
    }
    return json({ data: [...store.values()].reverse() });
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface Harness {
  base: string;
  db: Db;
  hub: RealtimeHub;
  processor: Processor;
  livepix: FakeLivePix;
  stop(): Promise<void>;
}

async function migrate(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const entry of readdirSync(dir).filter((name) => /^\d+_/.test(name)).sort()) {
    await client.query(readFileSync(join(dir, entry, "migration.sql"), "utf8"));
  }
  await client.end();
}

export async function startHarness(): Promise<Harness> {
  const database = await startPglite();
  await migrate(database.url);
  const db = createDb(database.url);
  const livepix = new FakeLivePix();
  const hub = new RealtimeHub();
  const secrets = createSecretBox("a".repeat(64));
  const processor = createProcessor({
    db,
    secrets,
    hub,
    livepix: createLivePixClient({ apiBase: LIVEPIX_API, tokenUrl: LIVEPIX_TOKEN, fetch: livepix.fetch as typeof fetch }),
  });

  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  const server: ServerType = await new Promise((resolve) => {
    const instance = serve({ fetch: (request) => handler(request), port: 0, hostname: "127.0.0.1" }, () => resolve(instance));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const auth = createAuth({ db, secret: "s".repeat(40), baseURL: base, allowSignup: true });
  const { app, injectWebSocket } = createApp({ db, auth, secrets, processor, hub, publicUrl: base, heartbeatMs: 200 });
  handler = app.fetch;
  injectWebSocket(server);

  return {
    base,
    db,
    hub,
    processor,
    livepix,
    async stop() {
      await processor.stop();
      await new Promise((resolve) => server.close(resolve));
      await db.$disconnect();
      await database.stop();
    },
  };
}

/** A signed-in browser: keeps the session cookie and sends the origin Better Auth expects. */
export class Browser {
  private cookie = "";
  constructor(private readonly base: string) {}

  async request(path: string, init: { method?: string; body?: unknown } = {}) {
    const response = await fetch(this.base + path, {
      method: init.method ?? "GET",
      headers: {
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length > 0) this.cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async signUp(email = `user${Math.random().toString(36).slice(2)}@example.com`) {
    const result = await this.request("/api/auth/sign-up/email", {
      method: "POST",
      body: { email, password: "correct-horse-battery", name: "Streamer" },
    });
    if (result.status !== 200) throw new Error("sign-up failed: " + JSON.stringify(result.body));
    return result;
  }
}

export function openSocket(url: string, token?: string) {
  const socket = new WebSocket(url, token ? { headers: { authorization: "Bearer " + token } } : {});
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
  });
  const rejected = new Promise<number>((resolve) => {
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  });
  async function next(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.findIndex((message) => message.type === type);
      if (found >= 0) return messages.splice(found, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`no ${type} message within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  return { socket, messages, next, closed, rejected };
}

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
