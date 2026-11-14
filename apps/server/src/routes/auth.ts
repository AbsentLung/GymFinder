// Mounts Better Auth at /v1/auth/*, adapting Fastify's request/reply to
// the Fetch API shape - not toNodeHandler, since Fastify already
// consumed the body stream that would need.
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
