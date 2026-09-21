import type { Donation } from "../generated/prisma/client.js";

/** The donation as the OSC Flow Studio plugin receives it, over the API and the WebSocket alike. */
export interface PluginDonation {
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

export function toPluginDonation(donation: Donation): PluginDonation {
  return {
    id: donation.key,
    seq: donation.seq.toString(),
    amount: donation.amount,
    currency: donation.currency,
    username: donation.username,
    message: donation.message,
    hasMessage: donation.message.length > 0,
    flagged: donation.flagged,
    livepixId: donation.livepixId,
    proof: donation.proof,
    reference: donation.reference,
    source: donation.source,
    occurredAt: donation.occurredAt.toISOString(),
    receivedAt: donation.receivedAt.toISOString(),
  };
}
