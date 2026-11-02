// Mounts Better Auth at /v1/auth/* (API.md 2.1) - we don't write these
// routes ourselves, just adapt Fastify's request/reply to the Fetch API
// Request/Response Better Auth's handler expects (confirmed against
// Better Auth's own Fastify integration guide, not memory).
//
// Deliberately NOT using Better Auth's `toNodeHandler`/`reply.hijack()`
// path: that hands the RAW Node request stream to Better Auth, but
// Fastify has already consumed that stream into `request.body` by the
// time any route handler runs - the raw stream would be empty/ended,
// a classic double-body-parsing bug. Re-serializing Fastify's
// already-parsed `request.body` into the new Request's body instead
// means nothing ever reads the raw stream twice.
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
