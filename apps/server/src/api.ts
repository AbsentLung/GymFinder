// API entry point - fast things only; anything slow goes through the
// queue to worker.ts. Demo mode runs both in one process; scale mode
// deploys them separately.
import Fastify from "fastify"
import cors from "@fastify/cors"
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod"
import { config } from "./config.js"
import { pool } from "./db/index.js"
import { queue } from "./queue/index.js"
import { tilesRoutes } from "./routes/tiles.js"
import { authRoutes } from "./routes/auth.js"
import { requestsRoutes } from "./routes/requests.js"
import { adminRoutes } from "./routes/admin.js"
import { gymsRoutes } from "./routes/gyms.js"
import { chatRoutes } from "./routes/chat.js"
import { meRoutes } from "./routes/me.js"

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
  await app.register(requestsRoutes)
  await app.register(adminRoutes)
  await app.register(gymsRoutes)
  await app.register(chatRoutes)
  await app.register(meRoutes)

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
