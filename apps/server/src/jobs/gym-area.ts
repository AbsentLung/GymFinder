// Fills gyms.area_id (LOCATION_NAMES.md): ST_Contains against `areas`
// first, Photon reverse-geocoding only when no polygon matches. Jobs
// carry only the gym id; a failure here never blocks the gym itself.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { queue } from "../queue/index.js"
import { checkRateLimit } from "../rate-limit.js"
import { reverseGeocodePlace } from "../geocode.js"
import { deepestAreaContainingSql } from "../area-queries.js"
import type { AreaLevel } from "../db/schema.js"
import type { PhotonPlace } from "../areas.js"

export const GYM_AREA_QUEUE = "gym-area"
export const GYM_AREA_PHOTON_QUEUE = "gym-area-photon"
export const AREA_BACKFILL_QUEUE = "area-backfill"

const BACKFILL_BATCH = 500
// Photon's public server asks for at most about one request per second.
const PHOTON_MAX_WAIT_MS = 60_000
const PHOTON_SLOT_POLL_MS = 1_100

export async function enqueueGymArea(gymId: number): Promise<void> {
  await queue.add(GYM_AREA_QUEUE, { gymId }, { jobId: `gym-area-${gymId}`, priority: "low" })
}

export async function processGymArea({ gymId }: { gymId: number }): Promise<void> {
  const point = sql`(SELECT location FROM gyms WHERE id = ${gymId})`
  const updated = await db.execute<{ area_id: number | null }>(sql`
    WITH m AS (SELECT id, country_code FROM areas WHERE id = ${deepestAreaContainingSql(point)})
    UPDATE gyms SET
      area_id = (SELECT id FROM m),
      country_code = COALESCE((SELECT country_code FROM m), gyms.country_code)
    WHERE gyms.id = ${gymId}
    RETURNING area_id
  `)
  const row = updated.rows[0]
  if (row && row.area_id === null) {
    await queue.add(
      GYM_AREA_PHOTON_QUEUE,
      { gymId },
      { jobId: `gym-area-photon-${gymId}`, priority: "low", retries: 5, retryDelayMs: 30_000 }
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

const PHOTON_LEVELS: ReadonlyArray<{ level: AreaLevel; key: keyof PhotonPlace }> = [
  { level: "region", key: "region" },
  { level: "county", key: "county" },
  { level: "city", key: "city" },
]

// Maps Photon's names onto areas we already have; never creates areas.
export async function matchPlaceToArea(place: PhotonPlace): Promise<number | null> {
  if (!place.countryCode) return null
  const country = await db.execute<{ id: number }>(sql`
    SELECT id FROM areas WHERE level = 'country' AND country_code = ${place.countryCode} ORDER BY ST_Area(geom) DESC LIMIT 1
  `)
  let deepest: number | null = country.rows[0]?.id ?? null
  for (const { level, key } of PHOTON_LEVELS) {
    const name = place[key]
    if (!name) continue
    // Prefer a child of what matched so far; names repeat across a country.
    const match: { rows: Array<{ id: number }> } = await db.execute<{ id: number }>(sql`
      SELECT id FROM areas
      WHERE level = ${level} AND country_code = ${place.countryCode} AND lower(name) = lower(${name})
      ORDER BY (parent_id IS NOT DISTINCT FROM ${deepest}) DESC, id
      LIMIT 1
    `)
    if (match.rows[0]) deepest = match.rows[0].id
  }
  return deepest
}

export async function processGymAreaPhoton({ gymId }: { gymId: number }): Promise<void> {
  const gym = await db.execute<{ lat: number; lng: number }>(sql`
    SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId} AND area_id IS NULL
  `)
  const coords = gym.rows[0]
  if (!coords) return // gone, or a polygon matched since

  await waitForPhotonSlot()
  const place = await reverseGeocodePlace(Number(coords.lat), Number(coords.lng))
  if (!place) return

  const areaId = await matchPlaceToArea(place)
  // Country code is still worth keeping without an area: it picks the price currency.
  await db.execute(sql`
    UPDATE gyms SET area_id = ${areaId}, country_code = COALESCE(${place.countryCode}, country_code)
    WHERE id = ${gymId} AND area_id IS NULL
  `)
}

// Pages through gyms with no area by id, one batch per job, chaining the next page.
export async function processAreaBackfill({ afterId }: { afterId: number }): Promise<void> {
  const page = await db.execute<{ id: number }>(sql`
    SELECT id FROM gyms WHERE area_id IS NULL AND id > ${afterId} ORDER BY id LIMIT ${BACKFILL_BATCH}
  `)
  for (const { id } of page.rows) await enqueueGymArea(Number(id))
  if (page.rows.length === BACKFILL_BATCH) {
    const lastId = Number(page.rows[page.rows.length - 1].id)
    await queue.add(AREA_BACKFILL_QUEUE, { afterId: lastId }, { jobId: `area-backfill-${lastId}`, priority: "low" })
  }
}
