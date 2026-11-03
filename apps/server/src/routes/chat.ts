// 🌐/🔑 - chat needs no account; reading back an answer only needs the
// random chatId itself, not a session.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { db } from "../db/index.js"
import { gyms } from "../db/schema.js"
import { eq } from "drizzle-orm"
import { cache } from "../cache/index.js"
import { queue } from "../queue/index.js"
import { checkRateLimit } from "../rate-limit.js"
import { getSessionUser } from "../auth-guard.js"
import { CHAT_TTL_SECONDS } from "../jobs/chat.js"

const MAX_HISTORY = 6
const CHAT_RATE_LIMIT_MAX = 10
const CHAT_RATE_LIMIT_WINDOW_SECONDS = 5 * 60

const chatBodySchema = z.object({
  question: z.string().min(1),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
})

export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/v1/gyms/:id/chat",
    { schema: { params: z.object({ id: z.coerce.number().int() }), body: chatBodySchema } },
    async (request, reply) => {
      const { id } = request.params
      const [gym] = await db.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, id))
      if (!gym) return reply.status(404).send({ error: "Gym not found" })

      // Per user if signed in, else per IP - a signed-out traveler can still chat.
      const sessionUser = await getSessionUser(request)
      const rateLimitKey = `chat:${sessionUser ? `user:${sessionUser.id}` : `ip:${request.ip}`}`
      const allowed = await checkRateLimit(rateLimitKey, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_SECONDS)
      if (!allowed) return reply.status(429).send({ error: "Too many chat messages - try again in a few minutes" })

      const chatId = crypto.randomUUID()
      // Last few messages, capped - a long conversation shouldn't make
      // every turn's prompt grow unbounded.
      const history = request.body.history.slice(-MAX_HISTORY).map((h) => ({ role: h.role, content: h.text }))

      await cache.set(`chat:${chatId}`, JSON.stringify({ status: "pending" }), CHAT_TTL_SECONDS)
      // Question/history never go into the job payload - see chat.ts.
      // processChat deletes this as soon as it's read.
      await cache.set(`chat:${chatId}:input`, JSON.stringify({ question: request.body.question, history }), CHAT_TTL_SECONDS)
      await queue.add("chat", { chatId, gymId: id })

      reply.status(202)
      return { chatId }
    }
  )

  app.get(
    "/v1/chats/:chatId",
    { schema: { params: z.object({ chatId: z.string().uuid() }) } },
    async (request) => {
      const raw = await cache.get(`chat:${request.params.chatId}`)
      // No cache entry covers both "never existed" and "TTL ran out" -
      // there's no separate "invalid id" to distinguish from expired.
      if (!raw) return { status: "expired" }
      return JSON.parse(raw)
    }
  )
}
