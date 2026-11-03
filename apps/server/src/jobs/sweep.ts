// API.md 2.4 / FR-11: "a user can request that a bot sweeps an area on
// Google Maps to find gyms missing from the map." Reuses the same
// gym_source_refs merge/dedup mechanics as the background Overpass
// refresh (src/jobs/gym-upsert.ts) with source="google_maps" - a gym
// Google Maps lists is itself one of the three sources FR-25 treats as
// already verified (our database, Google Maps, the gym's own website),
// so a sweep-found NEW gym's gym_changes row is created already decided
// (reviewStatus: "approved", decidedBy: "bot") - there's nothing for a
// separate bot-review LLM pass to independently confirm that the sweep
// itself didn't already establish by construction. Matches
// STACK_AND_SCHEMA.md 2.10's own ER diagram, which shows a sweep
// producing already-`approved` gym_changes rows directly.
//
// Deliberate scope cut: the old demo's researchNewGym (an LLM pass that
// fills in a newly-found gym's price/description/category after the
// scrape) isn't ported here - a sweep-found gym starts with just
// name/lat/lng, same minimal shape the Google Maps results list itself
// gives. A later chat question or edit request about that gym still
// goes through the normal, full bot-review pipeline.
import { sql, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, requests } from "../db/schema.js"
import { geohashToBounds } from "../lib.js"
import { googleMapsSource } from "../sources/index.js"
import { GoogleMapsBlockedError } from "../sources/google-maps-source.js"
import { upsertGym } from "./gym-upsert.js"
import type { ProposedChange } from "./bot-review.js"

// Module-level, not persisted - this process's own "how long to back
// off" state (STACK_AND_SCHEMA.md's "slower rate, longer pauses" when
// Google blocks the scraper). Doubles on every consecutive block, up
// to a 6-hour cap; a successful scrape resets it. Deliberately process-
// local rather than a DB/cache row: in scale mode each worker process
// backing off independently is fine - the point is never hammering
// Google at full rate right after it's already said no, not a single
// global rate limiter.
const INITIAL_BACKOFF_MS = 10 * 60 * 1000
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
let blockedUntil = 0
let nextBackoffMs = INITIAL_BACKOFF_MS

export async function processSweep({ requestId, geohash5 }: { requestId: number; geohash5: string }): Promise<void> {
  const bbox = geohashToBounds(geohash5)

  if (Date.now() < blockedUntil) {
    await markSweepFailed(requestId, geohash5)
    throw new GoogleMapsBlockedError(`Still backing off from a prior Google block until ${new Date(blockedUntil).toISOString()}`)
  }

  let found
  try {
    found = await googleMapsSource.findGymsInArea(bbox)
    nextBackoffMs = INITIAL_BACKOFF_MS // reset after a clean scrape
  } catch (e) {
    if (e instanceof GoogleMapsBlockedError) {
      blockedUntil = Date.now() + nextBackoffMs
      nextBackoffMs = Math.min(nextBackoffMs * 2, MAX_BACKOFF_MS)
    }
    await markSweepFailed(requestId, geohash5)
    throw e
  }

  let gymsNew = 0
  for (const g of found) {
    const result = await upsertGym("google_maps", g)
    if (!result) continue
    if (result.isNew) {
      gymsNew++
      const proposed: ProposedChange = {
        kind: "add_gym",
        name: g.name,
        lat: g.lat,
        lng: g.lng,
        categories: g.categories ?? [],
        address: g.address ?? null,
        description: g.description ?? null,
        prices: [],
      }
      // Already-decided, not queued for bot-review - see this file's
      // header comment. applyProposedChange isn't called either:
      // upsertGym already did the actual write (gyms + gym_source_refs),
      // this row is the audit trail (STACK_AND_SCHEMA.md 2.10 -
      // "gym_changes doubles as the audit log of every change to every
      // gym"), not a second write of the same gym.
      await db.insert(gymChanges).values({
        requestId,
        gymId: result.gymId,
        proposed,
        evidence: { reason: "Found via Google Maps sweep" },
        reviewStatus: "approved",
        decidedBy: "bot",
      })
    }
  }

  await db.execute(sql`
    INSERT INTO tile_fetches (geohash, source, last_fetched_at, status, gyms_found)
    VALUES (${geohash5}, 'google_maps', now(), 'ok', ${found.length})
    ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = now(), status = 'ok', gyms_found = ${found.length}
  `)
  await db.update(requests).set({ status: "completed", result: { gymsFound: found.length, gymsNew } }).where(eq(requests.id, requestId))
}

async function markSweepFailed(requestId: number, geohash5: string): Promise<void> {
  await db.update(requests).set({ status: "failed", failureReason: "sweep_failed" }).where(eq(requests.id, requestId))
  await db.execute(sql`
    INSERT INTO tile_fetches (geohash, source, last_fetched_at, status)
    VALUES (${geohash5}, 'google_maps', now(), 'failed')
    ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = now(), status = 'failed'
  `)
}
