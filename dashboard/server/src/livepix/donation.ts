export interface DonationInput {
  key: string;
  occurredAt: Date;
  amount: number;
  currency: string;
  username: string;
  message: string;
  flagged: boolean;
  livepixId: string;
  proof: string;
  reference: string;
  source: "message" | "payment";
  raw: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One donation, however it was read. Proof is what LivePix shares between a payment and its message. */
export function donationKey(item: Record<string, unknown>): string {
  return text(item.proof) || text(item.reference) || text(item.id);
}

export function toDonation(
  item: Record<string, unknown>,
  source: "message" | "payment",
  receivedAt: Date,
): DonationInput {
  const key = donationKey(item);
  if (!key) throw new Error("O LivePix devolveu uma doação sem id, proof ou reference");
  const amount = Math.round(Number(item.amount));
  if (!Number.isFinite(amount) || amount < 0) throw new Error("O LivePix devolveu um valor inválido: " + String(item.amount));
  const parsed = Date.parse(text(item.createdAt));
  return {
    key,
    occurredAt: Number.isNaN(parsed) ? receivedAt : new Date(parsed),
    amount,
    currency: text(item.currency).toUpperCase() || "BRL",
    username: text(item.username),
    message: text(item.message),
    flagged: item.flagged === true,
    livepixId: text(item.id),
    proof: text(item.proof),
    reference: text(item.reference),
    source,
    raw: item,
  };
}
