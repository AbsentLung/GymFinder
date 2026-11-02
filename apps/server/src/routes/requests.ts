// Add-gym/update-gym/sweep requests, shared status/retry endpoints, and
// "My requests" listing - share enough (one request row, a derived
// status, a common response shape) to build together.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, gyms, requests, tileFetches } from "../db/schema.js"
import { queue } from "../queue/index.js"
import { requireUser } from "../auth-guard.js"
import { requireDescription, GYM_CATEGORIES, isWithinStaleWindow } from "../lib.js"
import { NON_PRICE_FIELDS, createGymChange } from "../jobs/bot-review.js"
import type { ProposedChange } from "../jobs/bot-review.js"

const BOT_REVIEW_DEADLINE_MS = 10 * 60 * 1000
const SWEEP_DEADLINE_MS = 60 * 60 * 1000
// "Recently swept" - no number given in the docs for this specifically;
// reusing tiles.ts's own week-long Overpass-staleness window rather
// than inventing a different one with no basis.
const SWEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000
const GEOHASH5_PATTERN = /^[0-9b-hj-km-np-z]{5}$/

const sweepBodySchema = z.object({ geohash: z.string().regex(GEOHASH5_PATTERN, "must be a 5-character geohash") })

const priceProposalSchema = z.object({
  priceKind: z.enum(["day_pass", "week_pass", "month_pass"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  sourceKind: z.enum(["gym_website", "price_menu", "user", "review", "chat"]),
  sourceUrl: z.string().url().optional(),
  menuPostedOn: z.string().optional(),
})

const addGymSchema = z.object({
  name: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  categories: z.array(z.enum(GYM_CATEGORIES)).default([]),
  address: z.string().optional(),
  description: z.string().optional(),
  acceptsDropIn: z.boolean().optional(),
  hasTrial: z.boolean().optional(),
  prices: z.array(priceProposalSchema).default([]),
})

const changeSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("day_pass"), newValue: priceProposalSchema.omit({ priceKind: true }), description: z.string() }),
  z.object({ field: z.literal("week_pass"), newValue: priceProposalSchema.omit({ priceKind: true }), description: z.string() }),
  z.object({ field: z.literal("month_pass"), newValue: priceProposalSchema.omit({ priceKind: true }), description: z.string() }),
  z.object({ field: z.literal("status"), newValue: z.enum(["active", "closed", "hidden"]), description: z.string() }),
  z.object({ field: z.literal("name"), newValue: z.string().min(1), description: z.string() }),
  z.object({ field: z.literal("address"), newValue: z.string(), description: z.string() }),
  z.object({ field: z.literal("description"), newValue: z.string(), description: z.string() }),
  z.object({ field: z.literal("categories"), newValue: z.array(z.enum(GYM_CATEGORIES)), description: z.string() }),
  z.object({ field: z.literal("acceptsDropIn"), newValue: z.boolean(), description: z.string() }),
  z.object({ field: z.literal("hasTrial"), newValue: z.boolean(), description: z.string() }),
])

type ChangeBody = z.infer<typeof changeSchema>
const PRICE_KINDS = new Set(["day_pass", "week_pass", "month_pass"])

function toProposedChange(body: ChangeBody): ProposedChange {
  if (PRICE_KINDS.has(body.field)) {
    const nv = body.newValue as Omit<z.infer<typeof priceProposalSchema>, "priceKind">
    return { kind: "price", priceKind: body.field as "day_pass" | "week_pass" | "month_pass", justification: body.description, ...nv }
  }
  if (body.field === "status") return { kind: "status", newValue: body.newValue, justification: body.description }
  return { kind: "field", field: body.field as (typeof NON_PRICE_FIELDS)[number], newValue: body.newValue, justification: body.description }
}

async function serializeRequest(requestId: number) {
  const [request] = await db.select().from(requests).where(eq(requests.id, requestId))
  if (!request) return null
  const changes = await db.select().from(gymChanges).where(eq(gymChanges.requestId, requestId))
  return {
    id: String(request.id),
    kind: request.kind,
    status: request.status,
    createdAt: request.createdAt,
    deadline: request.deadline,
    result: request.result,
    failureReason: request.failureReason,
    changes: changes.map((c) => ({
      id: String(c.id),
      reviewStatus: c.reviewStatus,
      reason: c.reviewStatus === "rejected" ? (c.evidence as { reason?: string } | null)?.reason ?? null : null,
    })),
  }
}

async function createRequest(userId: number, kind: "add_gym" | "update_gym", input: unknown, gymId: number | null, proposed: ProposedChange) {
  const [request] = await db
    .insert(requests)
    .values({ userId, kind, deadline: new Date(Date.now() + BOT_REVIEW_DEADLINE_MS), input })
    .returning()

  // createGymChange is the one path every change creator uses - it also
  // handles a price's immediate-unverified write and queues bot-review.
  await createGymChange(request.id, gymId, proposed)
  return request.id
}

export const requestsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/v1/gyms",
    { preHandler: requireUser, schema: { body: addGymSchema } },
    async (request, reply) => {
      const body = request.body
      const proposed: ProposedChange = { kind: "add_gym", ...body }
      const requestId = await createRequest(request.sessionUser!.id, "add_gym", body, null, proposed)
      reply.status(202)
      return serializeRequest(requestId)
    }
  )

  app.post(
    "/v1/gyms/:id/changes",
    {
      preHandler: requireUser,
      schema: { params: z.object({ id: z.coerce.number().int() }), body: changeSchema },
    },
    async (request, reply) => {
      const { id } = request.params
      const [gym] = await db.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, id))
      if (!gym) return reply.status(404).send({ error: "Gym not found" })

      const descError = requireDescription(request.body.description)
      if (descError) return reply.status(400).send({ error: descError })

      const proposed = toProposedChange(request.body)
      const requestId = await createRequest(request.sessionUser!.id, "update_gym", { gymId: id, ...request.body }, id, proposed)
      reply.status(202)
      return serializeRequest(requestId)
    }
  )

  app.post(
    "/v1/sweeps",
    { preHandler: requireUser, schema: { body: sweepBodySchema } },
    async (request, reply) => {
      const { geohash } = request.body

      // "A tile swept recently returns 200 with an already-completed
      // request" (API.md 2.4) - reusing tile_fetches' own (geohash,
      // source) staleness tracking rather than a second table, same as
      // tiles.ts does for Overpass.
      const [fetchRow] = await db
        .select()
        .from(tileFetches)
        .where(and(eq(tileFetches.geohash, geohash), eq(tileFetches.source, "google_maps")))
      if (fetchRow && isWithinStaleWindow(fetchRow.lastFetchedAt, SWEEP_STALE_MS)) {
        const [recent] = await db
          .select()
          .from(requests)
          .where(and(eq(requests.kind, "sweep"), sql`${requests.input}->>'geohash' = ${geohash}`))
          .orderBy(desc(requests.id))
          .limit(1)
        if (recent) return serializeRequest(recent.id)
        // No stored request to point at (e.g. this cell was last swept
        // before sweeps produced one) - report from tile_fetches alone
        // rather than fail; there's nothing new to find either way.
        return {
          id: null,
          kind: "sweep",
          status: "completed",
          createdAt: fetchRow.lastFetchedAt,
          deadline: fetchRow.lastFetchedAt,
          result: { gymsFound: fetchRow.gymsFound ?? 0, gymsNew: 0 },
          failureReason: null,
          changes: [],
        }
      }

      // "A tile already queued attaches to the existing job" - same
      // dedup intent as tiles.ts's jobId, but a sweep has a `requests`
      // row to attach to directly.
      const [pending] = await db
        .select()
        .from(requests)
        .where(and(eq(requests.kind, "sweep"), eq(requests.status, "pending"), sql`${requests.input}->>'geohash' = ${geohash}`))
        .limit(1)
      if (pending) return serializeRequest(pending.id)

      const [created] = await db
        .insert(requests)
        .values({ userId: request.sessionUser!.id, kind: "sweep", deadline: new Date(Date.now() + SWEEP_DEADLINE_MS), input: { geohash } })
        .returning()
      await queue.add("sweep", { requestId: created.id, geohash5: geohash }, { jobId: `sweep:${geohash}` })
      reply.status(202)
      return serializeRequest(created.id)
    }
  )

  app.get(
    "/v1/requests/:id",
    { preHandler: requireUser, schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const [row] = await db.select().from(requests).where(eq(requests.id, request.params.id))
      if (!row) return reply.status(404).send({ error: "Not found" })
      if (row.userId !== request.sessionUser!.id && request.sessionUser!.role !== "admin") {
        return reply.status(403).send({ error: "Not your request" })
      }
      return serializeRequest(row.id)
    }
  )

  app.post(
    "/v1/requests/:id/retry",
    { preHandler: requireUser, schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const [row] = await db.select().from(requests).where(eq(requests.id, request.params.id))
      if (!row) return reply.status(404).send({ error: "Not found" })
      if (row.userId !== request.sessionUser!.id) return reply.status(403).send({ error: "Not your request" })
      if (row.status !== "failed") return reply.status(400).send({ error: "Only a failed request can be retried" })

      if (row.kind === "add_gym") {
        const input = row.input as z.infer<typeof addGymSchema>
        const proposed: ProposedChange = { kind: "add_gym", ...input }
        const requestId = await createRequest(request.sessionUser!.id, "add_gym", input, null, proposed)
        return serializeRequest(requestId)
      }

      if (row.kind === "sweep") {
        const { geohash } = row.input as { geohash: string }
        const [created] = await db
          .insert(requests)
          .values({ userId: request.sessionUser!.id, kind: "sweep", deadline: new Date(Date.now() + SWEEP_DEADLINE_MS), input: { geohash } })
          .returning()
        await queue.add("sweep", { requestId: created.id, geohash5: geohash }, { jobId: `sweep:${geohash}` })
        return serializeRequest(created.id)
      }

      const input = row.input as ChangeBody & { gymId: number }
      const proposed = toProposedChange(input)
      const requestId = await createRequest(request.sessionUser!.id, "update_gym", input, input.gymId, proposed)
      return serializeRequest(requestId)
    }
  )

  app.get(
    "/v1/me/requests",
    {
      preHandler: requireUser,
      schema: { querystring: z.object({ status: z.enum(["pending", "completed", "failed"]).optional(), cursor: z.coerce.number().int().optional() }) },
    },
    async (request) => {
      const { status, cursor } = request.query
      const rows = await db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.userId, request.sessionUser!.id),
            ...(status ? [eq(requests.status, status)] : []),
            ...(cursor ? [lt(requests.id, cursor)] : [])
          )
        )
        .orderBy(desc(requests.id))
        .limit(20)

      const items = await Promise.all(rows.map((r) => serializeRequest(r.id)))
      return { items, nextCursor: rows.length === 20 ? rows[rows.length - 1].id : null }
    }
  )
}
