// Mounts Better Auth at /v1/auth/* - adapts Fastify's request/reply to
// the Fetch API Request/Response its handler expects.
//
// Not using `toNodeHandler`/`reply.hijack()`: that hands Better Auth the
// raw Node stream, but Fastify already consumed it into `request.body` -
// re-serializing that instead avoids reading the stream twice.
import type { FastifyInstance } from "fastify"
import { auth } from "../auth.js"

export async function authRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/v1/auth/*",
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host}`)
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) {
        if (value) headers.append(key, Array.isArray(value) ? value.join(", ") : value)
      }

      const fetchRequest = new Request(url, {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })

      const response = await auth.handler(fetchRequest)

      reply.status(response.status)
      response.headers.forEach((value, key) => reply.header(key, value))
      const body = await response.text()
      return reply.send(body || null)
    },
  })
}
