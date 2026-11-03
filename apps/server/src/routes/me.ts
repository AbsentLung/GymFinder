// API.md 2.5 - push-token registration (for Expo push notifications on
// request status changes, src/jobs/push.ts) and account deletion.
// GET /v1/me/requests lives in src/routes/requests.ts instead, next to
// the serializeRequest it shares with every other request endpoint.
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
      // Unique on token alone - a reinstall under the same account (or,
      // in principle, a different account on the same device) moves the
      // existing row to the new owner rather than erroring or
      // duplicating.
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
    // A single DELETE, relying on the FK actions already declared in
    // src/db/schema.ts to do the right thing per table: session/account/
    // verification (Better Auth's own, cascade), push_tokens (cascade),
    // reviews (cascade - API.md 2.5: "reviews are removed"), requests
    // (set null - "requests are kept but unlinked"). gym_changes never
    // references users at all, so nothing to do there. "There are no
    // chats to delete" (API.md 2.5) - chats live only in the cache with
    // their own TTL, never tied to a user id in the first place.
    await db.delete(users).where(eq(users.id, request.sessionUser!.id))
    return { ok: true }
  })
}
