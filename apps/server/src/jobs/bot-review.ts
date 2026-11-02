// Bot review of a `gym_changes` row (STACK_AND_SCHEMA.md 2.10, FR-24 to
// FR-27) - ported from server/index.js's verifyEditRequest/
// EDIT_VERIFICATION_TOOLS, generalized from "one field at a time" (the
// old shape) to the three proposal kinds the new requests module
// produces (src/routes/requests.ts): a brand-new gym, a non-price field
// change, and a price change. applyApprovedChange is shared with the
// admin approve route (src/routes/admin.ts) - approval "applies the
// change to gyms / gym_prices in one transaction" (API.md 2.6) the same
// way regardless of who approved it.
import { sql, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, requests } from "../db/schema.js"
import { llm } from "../llm/index.js"
import { queue } from "../queue/index.js"
import { WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL } from "../llm/tools.js"
import { reverseGeocode } from "../geocode.js"
import { getFxRates } from "../fx.js"
import { convertToUsdCents, isDuplicateMatch, looksLikeRealCoordinates, amountMinorToMajor } from "../lib.js"
import type { ToolDef } from "../interfaces/llm.js"

export type PriceKind = "day_pass" | "week_pass" | "month_pass"
export type PriceSourceKind = "gym_website" | "price_menu" | "user" | "review" | "chat"
export const NON_PRICE_FIELDS = ["name", "address", "description", "categories", "acceptsDropIn", "hasTrial"] as const
export type NonPriceField = (typeof NON_PRICE_FIELDS)[number]

export interface PriceProposal {
  priceKind: PriceKind
  amountMinor: number
  currency: string
  sourceKind: PriceSourceKind
  sourceUrl?: string | null
  menuPostedOn?: string | null
}

export type ProposedChange =
  | {
      kind: "add_gym"
      name: string
      lat: number
      lng: number
      categories: string[]
      address?: string | null
      description?: string | null
      acceptsDropIn?: boolean | null
      hasTrial?: boolean | null
      prices: PriceProposal[]
    }
  | { kind: "field"; field: NonPriceField; newValue: unknown; justification: string }
  // "status" changes (closing/removing a gym) always go straight to
  // awaiting_admin (STACK_AND_SCHEMA.md 2.6: "always needs an admin") -
  // handled as its own kind rather than folding into NON_PRICE_FIELDS so
  // that routing can skip bot verification entirely, not just skip
  // auto-approval.
  | { kind: "status"; newValue: "active" | "closed" | "hidden"; justification: string }
  | ({ kind: "price"; justification: string } & PriceProposal)

interface ReviewResult {
  reviewStatus: "approved" | "rejected" | "awaiting_admin"
  decidedBy?: "bot"
  evidence: Record<string, unknown>
}

const CONFIRM_PRICE_TOOL: ToolDef = {
  name: "confirm_price_finding",
  description:
    "Report the price you found for comparison against the proposed value - in its ORIGINAL currency, unconverted. Call this once after searching, whether or not you found anything (price_amount null if you found nothing).",
  inputSchema: {
    type: "object",
    properties: {
      price_amount: { type: "number", description: "The numeric price you found, in its own currency. Omit/null if you found nothing credible." },
      price_currency: { type: "string", description: "ISO 4217 code for price_amount's currency, e.g. 'IDR', 'USD'." },
      reason: { type: "string" },
    },
    required: ["reason"],
  },
}

const CONFIRM_TEXT_TOOL: ToolDef = {
  name: "confirm_text_edit",
  description: "State your conclusion after searching for evidence (the gym's own website, reviews, listings) about one specific proposed value. Call this exactly once, after searching - not before.",
  inputSchema: {
    type: "object",
    properties: {
      confirmed: {
        type: "boolean",
        description: "True ONLY if you found a credible source that actually supports this specific value. False if you found contradicting info, or found nothing either way - don't guess true just because nothing contradicts it.",
      },
      reason: { type: "string" },
    },
    required: ["confirmed", "reason"],
  },
}

const CONFIRM_GYM_EXISTS_TOOL: ToolDef = {
  name: "confirm_gym_exists",
  description: "State your conclusion after searching for this gym. Call this exactly once, after searching.",
  inputSchema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "True only if you found a real listing or website for a gym matching this name and location." },
      sourceUrl: { type: "string", description: "The URL you confirmed it from, if found." },
      reason: { type: "string" },
    },
    required: ["found", "reason"],
  },
}

export async function verifyGymChange(change: ProposedChange, gymId: number | null): Promise<ReviewResult> {
  if (change.kind === "status") {
    // Never bot-reviewed at all, per STACK_AND_SCHEMA.md 2.6.
    return { reviewStatus: "awaiting_admin", evidence: { reason: "Closing/removing a gym always needs an admin." } }
  }
  if (change.kind === "add_gym") return verifyAddGym(change)
  if (change.kind === "price") return verifyPriceChange(change, gymId)

  const [gym] = await db.execute<{ name: string; lat: number; lng: number }>(sql`
    SELECT name, ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId}
  `).then((r) => r.rows)
  if (!gym) return { reviewStatus: "awaiting_admin", evidence: { reason: "Gym not found." } }
  return verifyFieldChangeForGym(change, gym)
}

async function findDuplicateGym(name: string, lat: number, lng: number): Promise<{ id: number } | null> {
  const nearby = await db.execute<{ id: number; name_similarity: number; distance_km: number }>(sql`
    SELECT id, similarity(name, ${name}) AS name_similarity,
      (6371 * acos(GREATEST(-1, LEAST(1,
        cos(radians(${lat})) * cos(radians(ST_Y(location))) * cos(radians(ST_X(location)) - radians(${lng})) +
        sin(radians(${lat})) * sin(radians(ST_Y(location)))
      )))) AS distance_km
    FROM gyms WHERE status = 'active' ORDER BY distance_km ASC LIMIT 3
  `)
  const match = nearby.rows.find((row) => isDuplicateMatch(row.distance_km, row.name_similarity))
  return match ? { id: match.id } : null
}

async function verifyAddGym(change: ProposedChange & { kind: "add_gym" }): Promise<ReviewResult> {
  // FR-26: the bot's own junk/duplicate rejections, checked before any
  // research - no point spending a search call on an obviously bad
  // submission.
  if (!change.name?.trim()) return { reviewStatus: "rejected", evidence: { reason: "Missing a gym name." } }
  if (!looksLikeRealCoordinates(change.lat, change.lng)) {
    return { reviewStatus: "rejected", evidence: { reason: "Location isn't a real, plausible coordinate." } }
  }
  const duplicate = await findDuplicateGym(change.name, change.lat, change.lng)
  if (duplicate) {
    return { reviewStatus: "rejected", evidence: { reason: "Matches an existing gym already in the database.", existingGymId: duplicate.id } }
  }

  const location = await reverseGeocode(change.lat, change.lng)
  if (!location) {
    // Can't resolve this to anywhere on land at all - the same signal
    // FR-26's "impossible location (e.g. in the sea)" example describes.
    return { reviewStatus: "rejected", evidence: { reason: "Location couldn't be resolved to any real place." } }
  }

  const response = await llm.runAgentTurn({
    system: `A traveler has proposed adding a new gym called "${change.name}" in ${location}. Try to find credible evidence this gym really exists there - its own website, or its Google Maps listing. Start with find_website_on_google_maps (it searches by name + location directly); fall back to web_search if that finds nothing. Then call confirm_gym_exists with your conclusion.`,
    tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL, CONFIRM_GYM_EXISTS_TOOL],
    messages: [{ role: "user", content: "Verify this gym exists." }],
  })
  const toolUse = response.toolUses.find((t) => t.name === "confirm_gym_exists")
  const found = toolUse?.input.found === true
  return found
    ? { reviewStatus: "approved", decidedBy: "bot", evidence: { reason: toolUse?.input.reason, sourceUrl: toolUse?.input.sourceUrl } }
    : { reviewStatus: "awaiting_admin", evidence: { reason: toolUse?.input.reason ?? "Couldn't confirm this gym exists." } }
}

async function verifyFieldChangeForGym(
  change: ProposedChange & { kind: "field" },
  gym: { name: string; lat: number; lng: number }
): Promise<ReviewResult> {
  const location = await reverseGeocode(gym.lat, gym.lng)
  const systemPrompt = `A traveler has proposed updating the ${change.field} for the gym "${gym.name}"${
    location ? ` in ${location}` : ""
  } to: ${formatFieldValue(change.newValue)}. Try to find credible evidence (the gym's own website, its Google Maps listing, OpenStreetMap) about this - include the location in your search query, not just the name. Start with web_search; its result snippets are short marketing excerpts that often won't show the actual fact you need, so use fetch_url on a promising result's real URL to read the page itself, or find_website_on_google_maps if you don't have a URL yet. Then call confirm_text_edit with your conclusion.`

  const response = await llm.runAgentTurn({
    system: systemPrompt,
    tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL, CONFIRM_TEXT_TOOL],
    messages: [{ role: "user", content: "Verify this proposed edit." }],
  })
  const toolUse = response.toolUses.find((t) => t.name === "confirm_text_edit")
  if (!toolUse) return { reviewStatus: "awaiting_admin", evidence: { reason: "Couldn't reach a conclusion." } }

  return toolUse.input.confirmed === true
    ? { reviewStatus: "approved", decidedBy: "bot", evidence: { reason: toolUse.input.reason } }
    : { reviewStatus: "awaiting_admin", evidence: { reason: toolUse.input.reason } }
}

function formatFieldValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value)
}

async function verifyPriceChange(
  change: ProposedChange & { kind: "price" },
  gymId: number | null
): Promise<ReviewResult> {
  if (!gymId) return { reviewStatus: "awaiting_admin", evidence: { reason: "No gym to verify this price against yet." } }
  const [gym] = await db.execute<{ name: string; lat: number; lng: number }>(sql`
    SELECT name, ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId}
  `).then((r) => r.rows)
  if (!gym) return { reviewStatus: "awaiting_admin", evidence: { reason: "Gym not found." } }

  const location = await reverseGeocode(gym.lat, gym.lng)
  const proposedMajor = amountMinorToMajor(change.amountMinor, change.currency)
  const proposedUsd = `$${((await resolveUsdCents(change.amountMinor, change.currency)) / 100).toFixed(2)} USD`
  const hint = change.sourceUrl ? ` The submitter pointed at ${change.sourceUrl} as their source - fetch that first.` : ""
  const systemPrompt = `A traveler has proposed a ${change.priceKind.replace("_", " ")} price for the gym "${gym.name}"${
    location ? ` in ${location}` : ""
  } of ${proposedMajor} ${change.currency} (${proposedUsd}).${hint} Try to find credible evidence of this gym's real price - the gym's own website is the only source that counts as verified (STACK_AND_SCHEMA.md 2.6); a review or listing site doesn't count, but is still worth reporting if that's all you find. Use fetch_url on a specific URL when you have one, web_search or find_website_on_google_maps otherwise. Then call confirm_price_finding with whatever price you found, in its original currency - don't convert it yourself.`

  const response = await llm.runAgentTurn({
    system: systemPrompt,
    tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL, CONFIRM_PRICE_TOOL],
    messages: [{ role: "user", content: "Verify this proposed price." }],
  })
  const toolUse = response.toolUses.find((t) => t.name === "confirm_price_finding")
  if (!toolUse) return { reviewStatus: "awaiting_admin", evidence: { reason: "Couldn't reach a conclusion." } }

  const { price_amount, price_currency, reason } = toolUse.input as { price_amount?: number; price_currency?: string; reason?: string }
  if (price_amount == null || !price_currency) return { reviewStatus: "awaiting_admin", evidence: { reason: reason ?? "No price found to compare." } }

  let foundCents: number
  try {
    const rates = price_currency === "USD" ? {} : await getFxRates()
    foundCents = convertToUsdCents(price_amount, price_currency, rates)
  } catch {
    return { reviewStatus: "awaiting_admin", evidence: { reason: `Found a price (${price_amount} ${price_currency}) but couldn't convert its currency to compare.` } }
  }

  // Same 15% tolerance as the old demo (server/index.js's
  // verifyEditRequest) - a price found via search is often slightly
  // stale or rounded. Both sides compared in USD cents - foundCents
  // already is; the proposed value needs the same conversion (it
  // arrives as amountMinor in ITS OWN currency's minor unit, not USD
  // cents - comparing it to foundCents directly would silently compare
  // the wrong units for any non-USD proposal).
  const proposedCents = await resolveUsdCents(change.amountMinor, change.currency)
  const withinTolerance = Math.abs(foundCents - proposedCents) <= proposedCents * 0.15
  return withinTolerance
    ? { reviewStatus: "approved", decidedBy: "bot", evidence: { reason, foundAmount: price_amount, foundCurrency: price_currency } }
    : { reviewStatus: "awaiting_admin", evidence: { reason, foundAmount: price_amount, foundCurrency: price_currency } }
}

// Applies an approved/rejected gym_changes row to `gyms`/`gym_prices` in
// one transaction (API.md 2.6), then recomputes the owning request's
// derived status - shared by the bot-review worker (this file's own
// caller) and the admin approve/reject routes (src/routes/admin.ts), so
// the actual data effect of "approved" is identical no matter who
// decided it.
export async function applyDecision(
  changeId: number,
  decision: { reviewStatus: "approved" | "rejected"; decidedBy: "bot" | "admin"; evidence?: Record<string, unknown> }
): Promise<void> {
  await db.transaction(async (tx) => {
    const [change] = await tx.select().from(gymChanges).where(eq(gymChanges.id, changeId))
    if (!change) throw new Error(`gym_changes ${changeId} not found`)
    const proposed = change.proposed as ProposedChange

    if (decision.reviewStatus === "approved") {
      await applyProposedChange(tx, proposed, change.gymId, decision.decidedBy)
    } else if (proposed.kind === "price") {
      // A rejected price shouldn't linger as a visible "unverified" row
      // (it was written immediately on submission - see
      // src/routes/requests.ts - precisely so users see it right away;
      // rejecting it is the one path that takes it back down).
      await tx.execute(sql`
        DELETE FROM gym_prices WHERE gym_id = ${change.gymId} AND kind = ${proposed.priceKind} AND is_verified = false
      `)
    }

    await tx
      .update(gymChanges)
      .set({
        reviewStatus: decision.reviewStatus,
        decidedBy: decision.decidedBy,
        evidence: decision.evidence ? { ...(change.evidence as object), ...decision.evidence } : change.evidence,
      })
      .where(eq(gymChanges.id, changeId))
  })

  const [change] = await db.select().from(gymChanges).where(eq(gymChanges.id, changeId))
  if (change?.requestId) await recomputeRequestStatus(change.requestId)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyProposedChange(tx: any, proposed: ProposedChange, gymId: number | null, decidedBy: "bot" | "admin"): Promise<void> {
  // Phase 4's migration carried old gym_submissions into gym_changes
  // using their ORIGINAL payload shape (migrate-demo-data.ts: `proposed:
  // s.payload`, e.g. `{ field: "day_pass_price_cents", newValue, ... }`),
  // predating this ProposedChange union entirely - a few of those rows
  // are still sitting in awaiting_admin right now. Falling through to
  // the price branch below for one of those would silently write
  // `undefined` into gym_prices instead of a real price. Known gap,
  // flagged rather than silently mishandled - fixing those specific old
  // rows (or writing an admin-side adapter for the pre-Phase-5 shape) is
  // follow-up work, not blocking this slice.
  if (!("kind" in proposed)) {
    throw new Error(`gym_changes row has a pre-Phase-5 proposed shape with no "kind" discriminator: ${JSON.stringify(proposed)}`)
  }
  if (proposed.kind === "add_gym") {
    const inserted = await tx.execute(sql`
      INSERT INTO gyms (name, location, address, description, categories, accepts_drop_in, has_trial)
      VALUES (${proposed.name}, ST_SetSRID(ST_MakePoint(${proposed.lng}, ${proposed.lat}), 4326),
        ${proposed.address ?? null}, ${proposed.description ?? null}, ${proposed.categories},
        ${proposed.acceptsDropIn ?? null}, ${proposed.hasTrial ?? null})
      RETURNING id
    `)
    const newGymId = inserted.rows[0].id
    for (const price of proposed.prices) {
      // Unverified on arrival, same as every other add_gym price - see
      // this module's header comment on the scope cut for add_gym price
      // verification.
      const usdCents = await resolveUsdCents(price.amountMinor, price.currency)
      await tx.execute(sql`
        INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, source_url, menu_posted_on)
        VALUES (${newGymId}, ${price.priceKind}, ${price.amountMinor}, ${price.currency},
          ${usdCents}, ${price.sourceKind}, ${price.sourceUrl ?? null}, ${price.menuPostedOn ?? null})
      `)
    }
    return
  }

  if (proposed.kind === "status") {
    await tx.execute(sql`UPDATE gyms SET status = ${proposed.newValue} WHERE id = ${gymId}`)
    return
  }

  if (proposed.kind === "field") {
    const column = FIELD_TO_COLUMN[proposed.field]
    await tx.execute(sql`UPDATE gyms SET ${sql.raw(column)} = ${proposed.newValue} WHERE id = ${gymId}`)
    return
  }

  // price: promote to the verified row, remove the now-superseded
  // unverified one (STACK_AND_SCHEMA.md 2.6: "when a verified price is
  // newer... the unverified row is removed").
  const usdCents = await resolveUsdCents(proposed.amountMinor, proposed.currency)
  await tx.execute(sql`
    INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, source_url, menu_posted_on, verified_by)
    VALUES (${gymId}, ${proposed.priceKind}, ${proposed.amountMinor}, ${proposed.currency}, ${usdCents}, ${proposed.sourceKind}, ${proposed.sourceUrl ?? null}, ${proposed.menuPostedOn ?? null}, ${decidedBy})
    ON CONFLICT (gym_id, kind, is_verified)
    DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, usd_cents = EXCLUDED.usd_cents,
      source_kind = EXCLUDED.source_kind, source_url = EXCLUDED.source_url, menu_posted_on = EXCLUDED.menu_posted_on,
      verified_by = EXCLUDED.verified_by, last_seen_at = now()
  `)
  await tx.execute(sql`DELETE FROM gym_prices WHERE gym_id = ${gymId} AND kind = ${proposed.priceKind} AND is_verified = false`)
}

async function resolveUsdCents(amountMinor: number, currency: string): Promise<number> {
  const rates = currency === "USD" ? {} : await getFxRates()
  return convertToUsdCents(amountMinorToMajor(amountMinor, currency), currency, rates)
}

// A price change is visible the moment it's submitted, unlike every
// other change kind (STACK_AND_SCHEMA.md 2.6's asymmetry) - shared by
// both real creators of a "price" gym_changes row: a user's own request
// (src/routes/requests.ts) and a fact the chatbot finds (src/jobs/chat.ts,
// FR-9 - which has no `requests` row to route through createRequest at
// all, API.md 1.4).
export async function insertUnverifiedPrice(gymId: number, proposed: PriceProposal): Promise<void> {
  const usdCents = await resolveUsdCents(proposed.amountMinor, proposed.currency)
  await db.execute(sql`
    INSERT INTO gym_prices (gym_id, kind, amount_minor, currency, usd_cents, source_kind, source_url, menu_posted_on)
    VALUES (${gymId}, ${proposed.priceKind}, ${proposed.amountMinor}, ${proposed.currency},
      ${usdCents}, ${proposed.sourceKind}, ${proposed.sourceUrl ?? null}, ${proposed.menuPostedOn ?? null})
    ON CONFLICT (gym_id, kind, is_verified)
    DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, usd_cents = EXCLUDED.usd_cents,
      source_kind = EXCLUDED.source_kind, source_url = EXCLUDED.source_url, menu_posted_on = EXCLUDED.menu_posted_on, last_seen_at = now()
  `)
}

// Creates one gym_changes row and queues its bot review - the one path
// every change creator uses (a request's createRequest, and a
// chat-found fact with no request at all), so every change gets
// reviewed the same way regardless of where it came from
// (STACK_AND_SCHEMA.md 2.10: "sweeps, chat facts and user submissions
// all produce the same gym_changes, so one approval flow").
export async function createGymChange(requestId: number | null, gymId: number | null, proposed: ProposedChange): Promise<number> {
  const [change] = await db.insert(gymChanges).values({ requestId, gymId, proposed }).returning()
  if (proposed.kind === "price" && gymId) await insertUnverifiedPrice(gymId, proposed)
  await queue.add("bot-review", { changeId: change.id }, { jobId: `bot-review:${change.id}` })
  return change.id
}

const FIELD_TO_COLUMN: Record<NonPriceField, string> = {
  name: "name",
  address: "address",
  description: "description",
  categories: "categories",
  acceptsDropIn: "accepts_drop_in",
  hasTrial: "has_trial",
}

// A request's user-facing status is derived from its gym_changes
// (STACK_AND_SCHEMA.md 2.10): pending while any change is still
// pending_bot/awaiting_admin, completed once every change has reached a
// terminal state (approved/rejected) - which can happen long after the
// bot's own ~10-minute deadline if a change needed an admin.
export async function recomputeRequestStatus(requestId: number): Promise<void> {
  const changes = await db.select().from(gymChanges).where(eq(gymChanges.requestId, requestId))
  const stillOpen = changes.some((c) => c.reviewStatus === "pending_bot" || c.reviewStatus === "awaiting_admin")
  if (stillOpen) return

  const counts = changes.reduce(
    (acc, c) => ({ ...acc, [c.reviewStatus]: (acc[c.reviewStatus as "approved" | "rejected"] ?? 0) + 1 }),
    {} as Record<"approved" | "rejected", number>
  )
  await db.update(requests).set({ status: "completed", result: counts }).where(eq(requests.id, requestId))
}
