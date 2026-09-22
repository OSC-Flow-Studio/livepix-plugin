import { createHash } from "node:crypto";

export interface LivePixCredentials {
  clientId: string;
  clientSecret: string;
}

export type LivePixResource = "messages" | "payments";

/** A failure talking to LivePix. `retryable` decides whether the delivery is retried on its own. */
export class LivePixError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "LivePixError";
  }
}

export interface LivePixClientOptions {
  apiBase: string;
  tokenUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface LivePixClient {
  get(credentials: LivePixCredentials, resource: LivePixResource, id: string): Promise<Record<string, unknown>>;
  list(credentials: LivePixCredentials, resource: LivePixResource, limit: number, page?: number): Promise<Record<string, unknown>[]>;
}

const SCOPE = "payments:read messages:read";

export function createLivePixClient(options: LivePixClientOptions): LivePixClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tokens = new Map<string, { value: string; expiresAt: number }>();

  const cacheKey = (credentials: LivePixCredentials) =>
    createHash("sha256").update(credentials.clientId + "\0" + credentials.clientSecret).digest("hex");

  async function send(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new LivePixError("Falha de rede ao falar com o LivePix: " + describe(error), true);
    }
  }

  async function token(credentials: LivePixCredentials): Promise<string> {
    const key = cacheKey(credentials);
    const cached = tokens.get(key);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;
    const response = await send(options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: SCOPE,
      }),
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new LivePixError(
        `OAuth do LivePix respondeu HTTP ${response.status}. Confira Client ID, Client Secret e os escopos ${SCOPE}.`,
        retryable,
        response.status,
      );
    }
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!payload || typeof payload.access_token !== "string") {
      throw new LivePixError("OAuth do LivePix não devolveu access_token", true);
    }
    const value = payload.access_token;
    tokens.set(key, { value, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000 });
    return value;
  }

  async function authorized(credentials: LivePixCredentials, url: URL, retry = true): Promise<unknown> {
    const bearer = await token(credentials);
    const response = await send(url, { headers: { authorization: "Bearer " + bearer, accept: "application/json" } });
    if (response.status === 401 && retry) {
      tokens.delete(cacheKey(credentials));
      return authorized(credentials, url, false);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500 || response.status === 401;
      throw new LivePixError(`LivePix respondeu HTTP ${response.status} em ${url.pathname}`, retryable, response.status);
    }
    const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return payload?.data;
  }

  return {
    async get(credentials, resource, id) {
      const url = new URL(`${resource}/${encodeURIComponent(id)}`, options.apiBase);
      const data = await authorized(credentials, url);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new LivePixError(`LivePix devolveu um ${resource} vazio para ${id}`, true);
      }
      return data as Record<string, unknown>;
    },
    async list(credentials, resource, limit, page = 1) {
      const url = new URL(resource, options.apiBase);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      const data = await authorized(credentials, url);
      if (!Array.isArray(data) || data.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new LivePixError("Invalid LivePix history response", true);
      }
      return data;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
