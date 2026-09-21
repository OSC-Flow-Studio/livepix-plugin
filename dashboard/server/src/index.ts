import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { createSecretBox } from "./crypto.js";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { createLivePixClient } from "./livepix/client.js";
import { createProcessor } from "./processor.js";
import { RealtimeHub } from "./realtime.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file: the variables come from the environment.
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const secrets = createSecretBox(env.ENCRYPTION_KEY);
const hub = new RealtimeHub();
const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.PUBLIC_URL,
  allowSignup: env.ALLOW_SIGNUP,
  trustedOrigins: [env.PUBLIC_URL, "http://localhost:5173"],
});
const logger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
};
const processor = createProcessor({
  db,
  secrets,
  hub,
  logger,
  livepix: createLivePixClient({ apiBase: env.LIVEPIX_API_BASE, tokenUrl: env.LIVEPIX_TOKEN_URL }),
});
const { app, injectWebSocket } = createApp({
  db,
  auth,
  secrets,
  processor,
  hub,
  publicUrl: env.PUBLIC_URL,
  webDist: env.WEB_DIST || undefined,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`OSC LivePix Dashboard listening on :${info.port} (${env.PUBLIC_URL})`);
});
injectWebSocket(server);
processor.start();

async function shutdown() {
  hub.broadcast({ type: "shutdown" });
  await processor.stop();
  server.close();
  await db.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
