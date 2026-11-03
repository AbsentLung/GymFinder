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
import { requestsRoutes } from "./routes/requests.js"
import { adminRoutes } from "./routes/admin.js"
import { gymsRoutes } from "./routes/gyms.js"
import { chatRoutes } from "./routes/chat.js"
import { meRoutes } from "./routes/me.js"

export async function buildApp() {
  const app = Fastify({ logger: true })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  // `credentials: true` (+ `origin: true`, which reflects whatever the
  // request's own Origin header is rather than a fixed allow-list) is
  // needed for the web app's session cookie to actually travel on a
  // cross-origin request at all - caught before it ever shipped broken:
  // the API and the web app's own dev server run on different ports
  // (and, in production, different domains/CDN origins), and a browser
  // silently drops a Set-Cookie response (and never sends the cookie
  // back later) for a cross-origin fetch unless the server explicitly
  // allows credentials - the previous no-options registration left this
  // header unset. `origin: true` is required alongside `credentials:
  // true`, not a separate choice - the CORS spec forbids the literal
  // wildcard `*` together with credentialed requests.
  await app.register(cors, { origin: true, credentials: true })

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
