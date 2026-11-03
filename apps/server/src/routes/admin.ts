// Admin review queue for gym_changes, plus role promotion.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, users } from "../db/schema.js"
import { requireAdmin } from "../auth-guard.js"
import { applyDecision } from "../jobs/bot-review.js"

interface CurrentGymRow {
  [key: string]: unknown
  id: number
  name: string
  lat: number
  lng: number
  address: string | null
  description: string | null
  categories: string[]
  accepts_drop_in: boolean | null
  has_trial: boolean | null
  status: string
}

// Raw SQL, not db.select().from(gyms) - the point customType's
// fromDriver hands back raw EWKB hex, not {lat, lng}. Same ST_X/ST_Y
// extraction tiles.ts and gyms.ts already use.
async function fetchCurrentGym(gymId: number) {
  const result = await db.execute<CurrentGymRow>(sql`
    SELECT id, name, ST_Y(location) AS lat, ST_X(location) AS lng, address, description,
           categories, accepts_drop_in, has_trial, status
    FROM gyms WHERE id = ${gymId}
  `)
  const gym = result.rows[0]
  if (!gym) return null
  return {
    id: gym.id,
    name: gym.name,
    location: { lat: Number(gym.lat), lng: Number(gym.lng) },
    address: gym.address,
    description: gym.description,
    categories: gym.categories ?? [],
    acceptsDropIn: gym.accepts_drop_in,
    hasTrial: gym.has_trial,
    status: gym.status,
  }
}

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
        rows.map(async (row) => ({
          id: String(row.id),
          requestId: row.requestId ? String(row.requestId) : null,
          gymId: row.gymId ? String(row.gymId) : null,
          proposed: row.proposed,
          currentGym: row.gymId ? await fetchCurrentGym(row.gymId) : null,
          evidence: row.evidence,
          reviewStatus: row.reviewStatus,
          decidedBy: row.decidedBy,
          createdAt: row.createdAt,
        }))
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
