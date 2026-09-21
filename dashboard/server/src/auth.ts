import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Db } from "./db.js";

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  allowSignup: boolean;
  trustedOrigins?: string[];
}

/** Prefix of every plugin token. The webhook id follows it: `olp_<webhookId>_<random>`. */
export const TOKEN_PREFIX = "olp_";

export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: prismaAdapter(options.db, { provider: "postgresql" }),
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: options.trustedOrigins ?? [options.baseURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.allowSignup,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    plugins: [
      apiKey({
        defaultPrefix: TOKEN_PREFIX,
        // The prefix carries the webhook id, so it is longer than the default allows.
        maximumPrefixLength: 40,
        defaultKeyLength: 48,
        enableMetadata: true,
        // Real-time delivery must never be throttled; the key itself is the gate.
        rateLimit: { enabled: false },
        startingCharactersConfig: { shouldStore: true, charactersLength: 36 },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Plugin tokens name their webhook: `olp_<webhookId>_<secret>`. */
export function webhookIdFromToken(token: string): string | null {
  const match = /^olp_([A-Za-z0-9]{8,64})_[A-Za-z0-9_-]+$/.exec(token);
  return match ? match[1]! : null;
}
