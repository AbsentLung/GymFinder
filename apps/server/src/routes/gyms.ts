// API.md 2.3 - full gym details and reviews. Separate from
// src/routes/tiles.ts's map-tile shape (truncated, filter-only fields):
// this is the "tap a pin" detail panel's full response, plus the
// reviews list/write endpoints the vibe-coded UI's reviews section and
// new "Edit" button (API.md decision #9) need.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { sql, eq, and, desc, lt } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymPrices, reviews } from "../db/schema.js"
import { requireUser, getSessionUser } from "../auth-guard.js"

interface GymDetailRow {
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
  details: Record<string, unknown> | null
  status: string
  updated_at: string
  rating: number | null
  review_count: number
}

async function fetchGymDetail(id: number) {
  const result = await db.execute<GymDetailRow>(sql`
    SELECT g.id, g.name, ST_X(g.location) AS lng, ST_Y(g.location) AS lat, g.address, g.description,
           g.categories, g.accepts_drop_in, g.has_trial, g.details, g.status, g.updated_at,
           (SELECT avg(rating)::float FROM reviews WHERE gym_id = g.id) AS rating,
           (SELECT count(*)::int FROM reviews WHERE gym_id = g.id) AS review_count
    FROM gyms g WHERE g.id = ${id}
  `)
  const gym = result.rows[0]
  if (!gym) return null

  const prices = await db.select().from(gymPrices).where(eq(gymPrices.gymId, id))
  // trialDetails/openingHours are promoted to their own top-level
  // fields (per API.md's own example response) - `details` carries
  // whatever's left of the jsonb catch-all (amenities, website, ...),
  // not a duplicate copy of the same two facts under two names.
  const { trialDetails, openingHours, ...restDetails } = (gym.details ?? {}) as Record<string, unknown>

  return {
    id: String(gym.id),
    name: gym.name,
    location: { lat: Number(gym.lat), lng: Number(gym.lng) },
    address: gym.address,
    categories: gym.categories ?? [],
    description: gym.description,
    acceptsDropIn: gym.accepts_drop_in,
    trial: { available: gym.has_trial ?? false, details: trialDetails ?? null },
    openingHours: openingHours ?? null,
    details: restDetails,
    prices: prices.map((p) => ({
      kind: p.kind,
      amountMinor: p.amountMinor,
      currency: p.currency,
      usdCents: p.usdCents,
      sourceKind: p.sourceKind,
      sourceUrl: p.sourceUrl,
      verifiedBy: p.verifiedBy,
      lastSeenAt: p.lastSeenAt,
    })),
    rating: gym.rating,
    reviewCount: gym.review_count,
    status: gym.status,
    // db.execute's raw-SQL escape hatch returns a timestamptz column as
    // the driver's plain string ("2026-11-02 10:02:02.627-05"), not a
    // parsed Date the way Drizzle's typed query builder does (confirmed
    // live - gymPrices.lastSeenAt above, read via .select(), serializes
    // to real ISO 8601 automatically; this raw-SQL field didn't) -
    // reparsed explicitly so every timestamp in this response uses the
    // same format.
    updatedAt: new Date(gym.updated_at).toISOString(),
  }
}

function serializeReview(r: typeof reviews.$inferSelect & { userName: string | null }, sessionUserId: number | null) {
  return {
    id: String(r.id),
    userName: r.userName,
    rating: r.rating,
    body: r.body,
    createdAt: r.createdAt,
    isMine: sessionUserId !== null && r.userId === sessionUserId,
  }
}

export const gymsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/gyms/:id",
    { schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const gym = await fetchGymDetail(request.params.id)
      if (!gym) return reply.status(404).send({ error: "Not found" })
      reply.header("Cache-Control", "public, s-maxage=300")
      return gym
    }
  )

  app.get(
    "/v1/gyms/:id/reviews",
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        querystring: z.object({ cursor: z.coerce.number().int().optional() }),
      },
    },
    async (request) => {
      const { id } = request.params
      const sessionUser = await getSessionUser(request)
      const rows = await db
        .select({
          id: reviews.id,
          gymId: reviews.gymId,
          userId: reviews.userId,
          rating: reviews.rating,
          body: reviews.body,
          createdAt: reviews.createdAt,
          userName: sql<string | null>`(SELECT name FROM users WHERE id = ${reviews.userId})`,
        })
        .from(reviews)
        .where(and(eq(reviews.gymId, id), ...(request.query.cursor ? [lt(reviews.id, request.query.cursor)] : [])))
        .orderBy(desc(reviews.id))
        .limit(20)

      return {
        items: rows.map((r) => serializeReview(r, sessionUser?.id ?? null)),
        nextCursor: rows.length === 20 ? rows[rows.length - 1].id : null,
      }
    }
  )

  app.post(
    "/v1/gyms/:id/reviews",
    {
      preHandler: requireUser,
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ rating: z.number().int().min(1).max(5), body: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.sessionUser!.id
      const [existing] = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.gymId, id), eq(reviews.userId, userId)))
      // One review per user per gym (API.md decision #9) - a second
      // attempt is a 409 pointing at PUT, not a silent second row.
      if (existing) return reply.status(409).send({ error: "You've already reviewed this gym - use PUT to edit it" })

      const [created] = await db
        .insert(reviews)
        .values({ gymId: id, userId, rating: request.body.rating, body: request.body.body ?? null })
        .returning()
      reply.status(201)
      return serializeReview({ ...created, userName: null }, userId)
    }
  )

  app.put(
    "/v1/gyms/:id/reviews/mine",
    {
      preHandler: requireUser,
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: z.object({ rating: z.number().int().min(1).max(5), body: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.sessionUser!.id
      const [updated] = await db
        .update(reviews)
        .set({ rating: request.body.rating, body: request.body.body ?? null })
        .where(and(eq(reviews.gymId, id), eq(reviews.userId, userId)))
        .returning()
      if (!updated) return reply.status(404).send({ error: "No review to edit yet - use POST to create one" })
      return serializeReview({ ...updated, userName: null }, userId)
    }
  )
}
