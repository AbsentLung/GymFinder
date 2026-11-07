// Add-gym/update-gym/sweep requests, shared status/retry endpoints, and
// "My requests" listing - share enough (one request row, a derived
// status, a common response shape) to build together.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, gyms, requests, tileFetches } from "../db/schema.js"
import { queue } from "../queue/index.js"
import { requireUser, getSessionUser } from "../auth-guard.js"
import { requireDescription, GYM_CATEGORIES, isFetchRowFresh, geohash5TilesCoveringBbox } from "../lib.js"
import { NON_PRICE_FIELDS, createGymChange } from "../jobs/bot-review.js"
import type { ProposedChange } from "../jobs/bot-review.js"
import { checkRateLimit } from "../rate-limit.js"
import { placeForChange } from "../area-queries.js"

const BOT_REVIEW_DEADLINE_MS = 10 * 60 * 1000
const SWEEP_DEADLINE_MS = 60 * 60 * 1000
// Same week-long window as tiles.ts's Overpass staleness.
const SWEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000
const GEOHASH5_PATTERN = /^[0-9b-hj-km-np-z]{5}$/
// A sweep launches a real browser and scrapes Google - tighter than a plain read.
const SWEEP_RATE_LIMIT_MAX = 5
const SWEEP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
// A viewport can cover dozens of cells - cap how many one bbox call fans out to.
const MAX_BBOX_CELLS = 20

const sweepBodySchema = z.union([
  z.object({ geohash: z.string().regex(GEOHASH5_PATTERN, "must be a 5-character geohash") }),
  z.object({
    // geohash5TilesCoveringBbox enumerates the whole bbox before MAX_BBOX_CELLS trims it.
    bbox: z
      .object({ minLat: z.number(), maxLat: z.number(), minLng: z.number(), maxLng: z.number() })
      .refine((b) => b.maxLat - b.minLat <= 0.5 && b.maxLng - b.minLng <= 0.5, "bbox span must be 0.5 degrees or less"),
  }),
])

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

// add_gym carries its own proposed name; update_gym only has a gymId,
// so the gym's current name is looked up instead.
async function resolveGymName(request: typeof requests.$inferSelect, changes: (typeof gymChanges.$inferSelect)[]): Promise<string | null> {
  if (request.kind === "add_gym") {
    const input = request.input as { name?: string } | null
    return input?.name ?? null
  }
  const gymId = changes[0]?.gymId
  if (!gymId) return null
  const [gym] = await db.select({ name: gyms.name }).from(gyms).where(eq(gyms.id, gymId))
  return gym?.name ?? null
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
    gymName: await resolveGymName(request, changes),
    changes: await Promise.all(
      changes.map(async (c) => ({
        id: String(c.id),
        reviewStatus: c.reviewStatus,
        reason: c.reviewStatus === "rejected" ? (c.evidence as { reason?: string } | null)?.reason ?? null : null,
        gymId: c.gymId ? String(c.gymId) : null,
        place: await placeForChange(c.gymId, c.proposed),
      }))
    ),
  }
}

// One geohash5 cell's worth of sweep - reused by both the single-cell
// and bbox-fan-out paths, so each cell still gets its own request/job.
async function sweepOneCell(geohash: string, userId: number | null): Promise<{ result: unknown; created: boolean }> {
  // A recently-swept tile returns the already-completed request -
  // reuses tile_fetches' own staleness tracking.
  const [fetchRow] = await db
    .select()
    .from(tileFetches)
    .where(and(eq(tileFetches.geohash, geohash), eq(tileFetches.source, "google_maps")))
  if (isFetchRowFresh(fetchRow, SWEEP_STALE_MS)) {
    const [recent] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.kind, "sweep"), sql`${requests.input}->>'geohash' = ${geohash}`))
      .orderBy(desc(requests.id))
      .limit(1)
    if (recent) return { result: await serializeRequest(recent.id), created: false }
    // No stored request to point at - report from tile_fetches alone.
    return {
      created: false,
      result: {
        id: null,
        kind: "sweep",
        status: "completed",
        createdAt: fetchRow.lastFetchedAt,
        deadline: fetchRow.lastFetchedAt,
        result: { gymsFound: fetchRow.gymsFound ?? 0, gymsNew: 0 },
        failureReason: null,
        changes: [],
      },
    }
  }

  // A tile already queued attaches to the existing request row.
  const [pending] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.kind, "sweep"), eq(requests.status, "pending"), sql`${requests.input}->>'geohash' = ${geohash}`))
    .limit(1)
  if (pending) return { result: await serializeRequest(pending.id), created: false }

  const [created] = await db
    .insert(requests)
    .values({ userId, kind: "sweep", deadline: new Date(Date.now() + SWEEP_DEADLINE_MS), input: { geohash } })
    .returning()
  // "-" not ":" - BullMQ rejects a custom id containing a colon.
  await queue.add("sweep", { requestId: created.id, geohash5: geohash }, { jobId: `sweep-${geohash}` })
  return { result: await serializeRequest(created.id), created: true }
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
    { schema: { body: sweepBodySchema } },
    async (request, reply) => {
      // FR-15/FR-22: the one request kind that doesn't need an account.
      // One check per call, not per cell - a bbox can cover dozens.
      const sessionUser = await getSessionUser(request)
      const rateLimitKey = `sweep:${sessionUser ? `user:${sessionUser.id}` : `ip:${request.ip}`}`
      const allowed = await checkRateLimit(rateLimitKey, SWEEP_RATE_LIMIT_MAX, SWEEP_RATE_LIMIT_WINDOW_SECONDS)
      if (!allowed) return reply.status(429).send({ error: "Too many sweeps - try again later" })

      const geohashes =
        "geohash" in request.body ? [request.body.geohash] : geohash5TilesCoveringBbox(request.body.bbox).slice(0, MAX_BBOX_CELLS)
      const cells = await Promise.all(geohashes.map((g) => sweepOneCell(g, sessionUser?.id ?? null)))

      if ("geohash" in request.body) {
        if (cells[0].created) reply.status(202)
        return cells[0].result
      }
      if (cells.some((c) => c.created)) reply.status(202)
      return { items: cells.map((c) => c.result) }
    }
  )

  app.get(
    "/v1/requests/:id",
    { schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      const [row] = await db.select().from(requests).where(eq(requests.id, request.params.id))
      if (!row) return reply.status(404).send({ error: "Not found" })
      // Only a sweep is meant to be public when userId is null (a deleted owner leaves the same null on other kinds).
      const isPublicSweep = row.kind === "sweep" && row.userId === null
      if (!isPublicSweep) {
        const sessionUser = await getSessionUser(request)
        if (!sessionUser) return reply.status(401).send({ error: "Sign in required" })
        if (row.userId !== sessionUser.id && sessionUser.role !== "admin") {
          return reply.status(403).send({ error: "Not your request" })
        }
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
        // "-" not ":" - BullMQ rejects a custom id containing a colon.
      await queue.add("sweep", { requestId: created.id, geohash5: geohash }, { jobId: `sweep-${geohash}` })
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
