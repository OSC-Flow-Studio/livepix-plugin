// Local Postgres without Docker: PGlite (Postgres compiled to WASM) behind the wire protocol.
// Used by the tests and handy for `npm run dev` on a machine with no database installed.
// Usage: node scripts/pglite-server.mjs [port] [dataDir]
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export async function startPglite({ port = 0, dataDir } = {}) {
  const db = await PGlite.create(dataDir ? { dataDir } : {});
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  const conn = server.getServerConn();
  return {
    url: `postgresql://postgres:postgres@${conn}/postgres?sslmode=disable`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

if (process.argv[1]?.endsWith("pglite-server.mjs")) {
  const port = Number(process.argv[2] ?? 5433);
  const pg = await startPglite({ port, dataDir: process.argv[3] });
  console.log(pg.url);
  process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
}
