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
  // Behind a real proxy/CDN, request.ip is otherwise the proxy's own
  // address - every signed-out caller would share one sweep rate-limit
  // bucket. Matches auth.ts's trustedOrigins reasoning for NODE_ENV.
  const app = Fastify({ logger: true, trustProxy: process.env.NODE_ENV === "production" })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  // credentials: true is needed for the web app's session cookie to
  // travel cross-origin at all - `origin: true` (reflect any origin)
  // used to be paired with it, which lets any website make credentialed
  // calls to every /v1 route once the cookie ever becomes SameSite=None.
  // Same allow-list as auth.ts's trustedOrigins instead.
  // methods defaults to GET,HEAD,POST only - every PUT/PATCH/DELETE route
  // (promote-to-admin, edit-my-review, unlink-push-token, delete-account)
  // would silently fail preflight on web otherwise, with no request ever
  // reaching the server to show up in a log.
  await app.register(cors, {
    origin: ["travelapp://", config.webOrigin, ...(process.env.NODE_ENV !== "production" ? [/^exp:\/\//] : [])],
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  })

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
