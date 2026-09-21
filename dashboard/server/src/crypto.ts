import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Alphanumeric id with about 143 bits of entropy. A webhook id is the only
 * thing protecting the public LivePix URL, so it must not be guessable. It is
 * alphanumeric because the plugin token embeds it between underscores.
 */
export function randomId(length = 24): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    const byte = bytes[i]!;
    // 248 is the largest multiple of 62 below 256; rejecting above it keeps the draw uniform.
    if (byte < 248) out += ALPHABET[byte % 62];
  }
  return out.length === length ? out : randomId(length);
}

export function parseKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64");
  return key;
}

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

/** AES-256-GCM. Output is `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function createSecretBox(rawKey: string): SecretBox {
  const key = parseKey(rawKey);
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), data].map((part) =>
        typeof part === "string" ? part : part.toString("base64url"),
      ).join(".");
    },
    open(sealed) {
      const [version, iv, tag, data] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
