// Fills gyms.region_id (LOCATION_NAMES.md): ST_Contains against `regions`
// first, Photon reverse-geocoding only when no polygon matches. Jobs
// carry only the gym id; a failure here never blocks the gym itself.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { queue } from "../queue/index.js"
import { checkRateLimit } from "../rate-limit.js"
import { reverseGeocodePlace } from "../geocode.js"
import { findRegionAt } from "../region-queries.js"
import type { PhotonPlace } from "../regions.js"

export const GYM_REGION_QUEUE = "gym-region"
export const GYM_REGION_PHOTON_QUEUE = "gym-region-photon"
export const REGION_BACKFILL_QUEUE = "region-backfill"

const BACKFILL_BATCH = 500
// Photon's public server asks for at most about one request per second.
const PHOTON_MAX_WAIT_MS = 60_000
const PHOTON_SLOT_POLL_MS = 1_100

export async function enqueueGymRegion(gymId: number): Promise<void> {
  await queue.add(GYM_REGION_QUEUE, { gymId }, { jobId: `gym-region-${gymId}`, priority: "low" })
}

export async function processGymRegion({ gymId }: { gymId: number }): Promise<void> {
  const gym = await db.execute<{ lat: number; lng: number }>(sql`
    SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId}
  `)
  const coords = gym.rows[0]
  if (!coords) return
  const region = await findRegionAt(Number(coords.lat), Number(coords.lng))
  await db.execute(sql`
    UPDATE gyms SET region_id = ${region?.id ?? null}, country_code = COALESCE(${region?.countryCode ?? null}, country_code)
    WHERE id = ${gymId}
  `)
  if (!region) {
    await queue.add(
      GYM_REGION_PHOTON_QUEUE,
      { gymId },
      { jobId: `gym-region-photon-${gymId}`, priority: "low", retries: 5, retryDelayMs: 30_000 }
    )
  }
}

// Shared across workers through the cache (Redis in scale mode).
async function waitForPhotonSlot(): Promise<void> {
  const deadline = Date.now() + PHOTON_MAX_WAIT_MS
  while (!(await checkRateLimit("photon-reverse", 1, 1))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a Photon rate-limit slot")
    await new Promise((resolve) => setTimeout(resolve, PHOTON_SLOT_POLL_MS))
  }
}

// Maps Photon's state name onto a region we already have; never creates regions.
export async function matchPlaceToRegion(place: PhotonPlace): Promise<number | null> {
  if (!place.countryCode || !place.region) return null
  const match = await db.execute<{ id: number }>(sql`
    SELECT id FROM regions WHERE country_code = ${place.countryCode} AND lower(name) = lower(${place.region}) ORDER BY id LIMIT 1
  `)
  return match.rows[0] ? Number(match.rows[0].id) : null
}

export async function processGymRegionPhoton({ gymId }: { gymId: number }): Promise<void> {
  const gym = await db.execute<{ lat: number; lng: number }>(sql`
    SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId} AND region_id IS NULL
  `)
  const coords = gym.rows[0]
  if (!coords) return // gone, or a polygon matched since

  await waitForPhotonSlot()
  const place = await reverseGeocodePlace(Number(coords.lat), Number(coords.lng))
  if (!place) return

  const regionId = await matchPlaceToRegion(place)
  // Country code is still worth keeping without a region: it picks the price currency.
  await db.execute(sql`
    UPDATE gyms SET region_id = ${regionId}, country_code = COALESCE(${place.countryCode}, country_code)
    WHERE id = ${gymId} AND region_id IS NULL
  `)
}

// Pages through gyms with no region by id, one batch per job, chaining the next page.
export async function processRegionBackfill({ afterId }: { afterId: number }): Promise<void> {
  const page = await db.execute<{ id: number }>(sql`
    SELECT id FROM gyms WHERE region_id IS NULL AND id > ${afterId} ORDER BY id LIMIT ${BACKFILL_BATCH}
  `)
  for (const { id } of page.rows) await enqueueGymRegion(Number(id))
  if (page.rows.length === BACKFILL_BATCH) {
    const lastId = Number(page.rows[page.rows.length - 1].id)
    await queue.add(REGION_BACKFILL_QUEUE, { afterId: lastId }, { jobId: `region-backfill-${lastId}`, priority: "low" })
  }
}
