export interface WebhookView {
  id: string;
  name: string;
  active: boolean;
  livepixClientId: string;
  hasLivepixClientSecret: boolean;
  token: { start: string; createdAt: string | null } | null;
  webhookUrl: string;
  apiUrl: string;
  websocketUrl: string;
  stats: { deliveries: number; donations: number; pending: number; sockets: number; lastDeliveryAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = "pending" | "processed" | "duplicate" | "ignored" | "failed";

export interface DeliverySummary {
  id: string;
  receivedAt: string;
  status: DeliveryStatus;
  event: string | null;
  resourceType: string | null;
  resourceId: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  donation: { amount: number; currency: string; username: string } | null;
}

export interface Donation {
  id: string;
  seq: string;
  amount: number;
  currency: string;
  username: string;
  message: string;
  hasMessage: boolean;
  flagged: boolean;
  livepixId: string;
  proof: string;
  reference: string;
  source: string;
  occurredAt: string;
  receivedAt: string;
}

export interface DeliveryDetail extends Omit<DeliverySummary, "donation"> {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  remoteIp: string | null;
  processedAt: string | null;
  donation: Donation | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (payload as { error?: string }).error ?? "request_failed");
  return payload as T;
}

export function formatMoney(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDateTime(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}
