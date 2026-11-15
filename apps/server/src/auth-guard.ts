// Session reading for 🔒/🛡️ routes. Uses `fromNodeHeaders` only (never
// `toNodeHandler`) - it just converts headers, so it's safe outside the
// auth.handler passthrough.
import type { FastifyRequest, FastifyReply } from "fastify"
import { fromNodeHeaders } from "better-auth/node"
import { auth } from "./auth.js"

export interface SessionUser {
  id: number
  role: string
}

export async function getSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
  if (!session) return null
  return { id: Number(session.user.id), role: (session.user as { role?: string }).role ?? "user" }
}

declare module "fastify" {
  interface FastifyRequest {
    sessionUser?: SessionUser
  }
}

// 🔒 - signed in, any role.
export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getSessionUser(request)
  if (!user) return reply.status(401).send({ error: "Sign in required" })
  request.sessionUser = user
}

// 🛡️ - signed in AND role = admin.
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = await getSessionUser(request)
  if (!user) return reply.status(401).send({ error: "Sign in required" })
  if (user.role !== "admin") return reply.status(403).send({ error: "Admin only" })
  request.sessionUser = user
}
