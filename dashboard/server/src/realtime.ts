export interface Subscriber {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Plugin sockets grouped by webhook. One process holds them all; running
 * several instances would need a shared channel (Postgres LISTEN/NOTIFY) here.
 */
export class RealtimeHub {
  private readonly groups = new Map<string, Set<Subscriber>>();

  subscribe(webhookId: string, subscriber: Subscriber): () => void {
    let group = this.groups.get(webhookId);
    if (!group) {
      group = new Set();
      this.groups.set(webhookId, group);
    }
    group.add(subscriber);
    return () => {
      group.delete(subscriber);
      if (group.size === 0 && this.groups.get(webhookId) === group) this.groups.delete(webhookId);
    };
  }

  publish(webhookId: string, message: unknown): number {
    const group = this.groups.get(webhookId);
    if (!group) return 0;
    const data = JSON.stringify(message);
    let sent = 0;
    for (const subscriber of group) {
      try {
        subscriber.send(data);
        sent += 1;
      } catch {
        // A broken socket is cleaned up by its own close handler; the others still get the event.
      }
    }
    return sent;
  }

  broadcast(message: unknown): void {
    for (const webhookId of this.groups.keys()) this.publish(webhookId, message);
  }

  /** Closes every socket of a webhook, used when its token is revoked or the webhook is switched off. */
  disconnect(webhookId: string, code: number, reason: string): void {
    const group = this.groups.get(webhookId);
    if (!group) return;
    this.groups.delete(webhookId);
    for (const subscriber of group) {
      try {
        subscriber.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  count(webhookId: string): number {
    return this.groups.get(webhookId)?.size ?? 0;
  }
}
