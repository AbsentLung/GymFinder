// API entry point - fast things only (reads, auth, accepting requests).
// Anything slow goes through the queue and is handled by worker.ts
// (DESIGN_DISCUSSION.md Option B). Demo mode can run both entry points
// in one process (see package.json's "dev" script); scale mode deploys
// them as separate services.
import Fastify from "fastify"
import cors from "@fastify/cors"
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod"
import { config } from "./config.js"
import { pool } from "./db/index.js"
import { queue } from "./queue/index.js"
import { tilesRoutes } from "./routes/tiles.js"
import { authRoutes } from "./routes/auth.js"

export async function buildApp() {
  const app = Fastify({ logger: true })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(cors)

  // Not under /v1 (API.md 1.6) - for the load balancer/Docker, not the app.
  app.get("/healthz", async () => ({ status: "ok" }))
  app.get("/readyz", async (_request, reply) => {
    try {
      await pool.query("SELECT 1")
    } catch (e) {
      reply.code(503)
      return { status: "error", reason: `database: ${(e as Error).message}` }
    }
    return { status: "ok" }
  })

  await app.register(authRoutes)
  await app.register(tilesRoutes)

  return app
}

async function main() {
  await queue.start()
  const app = await buildApp()
  await app.listen({ port: config.port, host: "0.0.0.0" })
}

// Only auto-start when run directly (`node api.js` / `tsx src/api.ts`),
// not when imported by a test that wants buildApp() without a live
// listener.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("API failed to start:", e)
    process.exit(1)
  })
}
