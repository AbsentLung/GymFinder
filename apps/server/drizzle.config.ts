import { defineConfig } from "drizzle-kit"

// Points at the NEW schema (src/db/schema.ts), not the old apps/server/
// db/*.sql dump, which stays as a read-only reference for Phase 4's
// migration script. DATABASE_URL defaults to the local docker-compose
// Postgres (see docker-compose.yml at the repo root).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/gymfinder",
  },
})
