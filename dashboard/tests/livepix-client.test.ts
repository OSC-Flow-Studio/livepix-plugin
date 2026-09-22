import { expect, it } from "vitest";
import { createLivePixClient } from "../server/src/livepix/client.js";

it.each([{ data: {} }, { data: [null] }])("does not treat malformed successful history responses as the end of history: %j", async (payload) => {
  const client = createLivePixClient({
    apiBase: "https://api.example.test/v2/", tokenUrl: "https://auth.example.test/token",
    fetch: async (url) => new Response(JSON.stringify(String(url).endsWith("/token")
      ? { access_token: "test-token", expires_in: 3600 } : payload), { status: 200 }),
  });
  await expect(client.list({ clientId: "client", clientSecret: "secret" }, "payments", 100, 2)).rejects.toThrow("Invalid LivePix history response");
});
