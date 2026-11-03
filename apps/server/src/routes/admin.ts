// API.md 2.6 - the admin review queue for gym_changes awaiting_admin,
// plus a spot-check view of what the bot auto-approved, plus role
// promotion (replacing the demo's removed "apply to be admin" flow).
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { and, asc, eq, gt } from "drizzle-orm"
import { db } from "../db/index.js"
import { gyms, gymChanges, users } from "../db/schema.js"
import { requireAdmin } from "../auth-guard.js"
import { applyDecision } from "../jobs/bot-review.js"

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/admin/changes",
    {
      preHandler: requireAdmin,
      schema: {
        querystring: z.object({
          reviewStatus: z.enum(["pending_bot", "awaiting_admin", "approved", "rejected"]).optional(),
          decidedBy: z.enum(["bot", "admin"]).optional(),
          cursor: z.coerce.number().int().optional(),
        }),
      },
    },
    async (request) => {
      const { reviewStatus, decidedBy, cursor } = request.query
      const conditions = [
        ...(reviewStatus ? [eq(gymChanges.reviewStatus, reviewStatus)] : []),
        ...(decidedBy ? [eq(gymChanges.decidedBy, decidedBy)] : []),
        ...(cursor ? [gt(gymChanges.id, cursor)] : []),
      ]
      const rows = await db
        .select()
        .from(gymChanges)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(gymChanges.id))
        .limit(20)

      const items = await Promise.all(
        rows.map(async (row) => {
          const [gym] = row.gymId ? await db.select().from(gyms).where(eq(gyms.id, row.gymId)) : []
          return {
            id: String(row.id),
            requestId: row.requestId ? String(row.requestId) : null,
            gymId: row.gymId ? String(row.gymId) : null,
            proposed: row.proposed,
            currentGym: gym ?? null,
            evidence: row.evidence,
            reviewStatus: row.reviewStatus,
            decidedBy: row.decidedBy,
            createdAt: row.createdAt,
          }
        })
      )
      return { items, nextCursor: rows.length === 20 ? rows[rows.length - 1].id : null }
    }
  )

  app.post(
    "/v1/admin/changes/:id/approve",
    { preHandler: requireAdmin, schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const [change] = await db.select().from(gymChanges).where(eq(gymChanges.id, request.params.id))
      if (!change) return reply.status(404).send({ error: "Not found" })
      if (change.reviewStatus === "approved" || change.reviewStatus === "rejected") {
        return reply.status(409).send({ error: "Already decided" })
      }
      await applyDecision(change.id, { reviewStatus: "approved", decidedBy: "admin" })
      return { ok: true }
    }
  )

  app.post(
    "/v1/admin/changes/:id/reject",
    { preHandler: requireAdmin, schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ reason: z.string().min(1) }) } },
    async (request, reply) => {
      const [change] = await db.select().from(gymChanges).where(eq(gymChanges.id, request.params.id))
      if (!change) return reply.status(404).send({ error: "Not found" })
      if (change.reviewStatus === "approved" || change.reviewStatus === "rejected") {
        return reply.status(409).send({ error: "Already decided" })
      }
      // Same `reason` key the bot's own evidence uses - serializeRequest
      // reads it as THE reason shown to the user.
      await applyDecision(change.id, { reviewStatus: "rejected", decidedBy: "admin", evidence: { reason: request.body.reason } })
      return { ok: true }
    }
  )

  app.patch(
    "/v1/admin/users/:id",
    {
      preHandler: requireAdmin,
      schema: { params: z.object({ id: z.coerce.number().int() }), body: z.object({ role: z.enum(["admin", "user"]) }) },
    },
    async (request, reply) => {
      const [updated] = await db.update(users).set({ role: request.body.role }).where(eq(users.id, request.params.id)).returning()
      if (!updated) return reply.status(404).send({ error: "Not found" })
      return { id: String(updated.id), role: updated.role }
    }
  )
}
