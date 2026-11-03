// A bot sweeps an area on Google Maps for missing gyms. Google Maps is
// itself one of FR-25's verified sources, so a sweep-found gym's
// gym_changes row is created already approved - no separate bot-review
// pass needed. Starts with just name/lat/lng; a later chat question or
// edit still goes through the normal pipeline.
import { sql, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges, requests } from "../db/schema.js"
import { geohashToBounds } from "../lib.js"
import { googleMapsSource } from "../sources/index.js"
import { GoogleMapsBlockedError } from "../sources/google-maps-source.js"
import { upsertGym } from "./gym-upsert.js"
import type { ProposedChange } from "./bot-review.js"

// Process-local backoff state - doubles on every consecutive Google
// block, up to a 6-hour cap; a clean scrape resets it.
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
      // Already-decided, not queued for bot-review - upsertGym already
      // did the write; this row is just the audit trail.
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
