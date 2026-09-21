import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Public origin of the dashboard, used in the webhook URLs shown to users. */
  PUBLIC_URL: z.string().url().default("https://livepix.maned.club"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET needs at least 32 characters"),
  /** 32 bytes as base64 or hex. Encrypts the LivePix client secrets at rest. */
  ENCRYPTION_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  ALLOW_SIGNUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LIVEPIX_API_BASE: z.string().url().default("https://api.livepix.gg/v2/"),
  LIVEPIX_TOKEN_URL: z.string().url().default("https://oauth.livepix.gg/oauth2/token"),
  /** Directory with the built frontend. Empty disables static serving (dev uses Vite). */
  WEB_DIST: z.string().default("dist/web"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error("Invalid environment:\n" + issues.join("\n"));
  }
  return parsed.data;
}
