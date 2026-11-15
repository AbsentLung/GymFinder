// Push-token registration and account deletion. GET /v1/me/requests
// lives in routes/requests.ts, next to serializeRequest.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { pushTokens, users } from "../db/schema.js"
import { requireUser } from "../auth-guard.js"

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/v1/me/push-tokens",
    {
      preHandler: requireUser,
      schema: { body: z.object({ expoPushToken: z.string().min(1), platform: z.enum(["ios", "android", "web"]) }) },
    },
    async (request, reply) => {
      // Unique on token alone - a reinstall moves the row to its new
      // owner rather than erroring or duplicating.
      await db
        .insert(pushTokens)
        .values({ userId: request.sessionUser!.id, token: request.body.expoPushToken, platform: request.body.platform })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: { userId: request.sessionUser!.id, platform: request.body.platform },
        })
      reply.status(201)
      return { ok: true }
    }
  )

  app.delete(
    "/v1/me/push-tokens/:token",
    { preHandler: requireUser, schema: { params: z.object({ token: z.string().min(1) }) } },
    async (request) => {
      await db
        .delete(pushTokens)
        .where(and(eq(pushTokens.token, request.params.token), eq(pushTokens.userId, request.sessionUser!.id)))
      return { ok: true }
    }
  )

  app.delete("/v1/me", { preHandler: requireUser }, async (request) => {
    // A single DELETE - the FK actions already on schema.ts handle each
    // table (cascade for reviews/push_tokens, set null for requests).
    await db.delete(users).where(eq(users.id, request.sessionUser!.id))
    return { ok: true }
  })
}
