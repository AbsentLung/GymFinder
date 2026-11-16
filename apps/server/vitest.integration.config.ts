import { defineConfig } from "vitest/config"

// Real Postgres + PostGIS (and Redis when MODE=scale); `npm run test:integration` runs it once per mode.
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/gymfinder_test"

export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      DATABASE_URL: databaseUrl,
      // Scale mode's config demands one at startup; these tests never call the LLM.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key-not-used",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "integration-test-secret-not-real-0000000000",
    },
  },
})
