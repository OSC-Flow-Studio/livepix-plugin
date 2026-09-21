import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {
  // No .env file: the variables come from the environment (Docker, CI).
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
