// POST /v1/sweeps is deliberately NOT here yet (FR-11) - a separate
// slice per the original "modules split so they can be built in
// parallel" plan (STACK_AND_SCHEMA.md 1.2). This covers API.md 2.4's
// add-gym/update-gym requests, 2.4's shared status/retry endpoints, and
// 2.5's "My requests" listing - the add-gym and update-gym routes share
// almost everything (one request + one gym_changes row, then a queued
// bot-review job), so building them together was the natural cut.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, gyms, requests } from "../db/schema.js"
import { queue } from "../queue/index.js"
import { requireUser } from "../auth-guard.js"
import { requireDescription, GYM_CATEGORIES, convertToUsdCents, amountMinorToMajor } from "../lib.js"
import { getFxRates } from "../fx.js"
import { NON_PRICE_FIELDS } from "../jobs/bot-review.js"
import type { ProposedChange } from "../jobs/bot-review.js"

const BOT_REVIEW_DEADLINE_MS = 10 * 60 * 1000

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

  await db.insert(gymChanges).values({ requestId: request.id, gymId, proposed })

  // A price change is visible the moment it's submitted, unlike every
  // other change kind - STACK_AND_SCHEMA.md 2.6: "An unverified price is
  // stored straight away... so users see it at once, clearly marked
  // unverified," independent of whatever gym_changes/bot review decides.
  if (proposed.kind === "price" && gymId) {
    const rates = proposed.currency === "USD" ? {} : await getFxRates()
    const usdCents = convertToUsdCents(amountMinorToMajor(proposed.amountMinor, proposed.currency), proposed.currency, rates)
    await db.execute(sql`
      INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, source_url, menu_posted_on)
      VALUES (${gymId}, ${proposed.priceKind}, ${proposed.amountMinor}, ${proposed.currency},
        ${usdCents}, ${proposed.sourceKind}, ${proposed.sourceUrl ?? null}, ${proposed.menuPostedOn ?? null})
      ON CONFLICT (gym_id, kind, is_verified)
      DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, usd_cents = EXCLUDED.usd_cents,
        source_kind = EXCLUDED.source_kind, source_url = EXCLUDED.source_url, menu_posted_on = EXCLUDED.menu_posted_on, last_seen_at = now()
    `)
  }

  // "-" not ":" - BullMQ rejects a custom id containing a colon.
  await queue.add("bot-review", { requestId: request.id }, { jobId: `bot-review-${request.id}` })
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
