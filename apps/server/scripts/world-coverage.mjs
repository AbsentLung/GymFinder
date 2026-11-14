// Run once a day (cron/launchd - not wired up here, this is just the unit
// of work one day's run performs) to gradually seed gym data for areas
// nobody's searched yet. docs/gym-data-design.md: this is the complement
// to the lazy per-area refresh in server/index.js, not a replacement for
// it - that one keeps popular areas fresh on demand; this one reaches
// areas with no organic traffic at all.
import pg from "pg"

const pool = new pg.Pool({ database: "travelapp" })

const GRID_DEGREES = 10
const DAILY_QUERY_BUDGET = 80 // headroom under Overpass's ~100/day fair-use guidance, not right up against it
const AREA_STALE_MS = 7 * 24 * 60 * 60 * 1000
const MIN_DELAY_MS = 1500
const MAX_DELAY_MS = 3500

function jitteredDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)
}

async function fetchOverpassGyms({ minLat, minLng, maxLat, maxLng }) {
  const query = `[out:json][timeout:120];nwr["leisure"="fitness_centre"](${minLat},${minLng},${maxLat},${maxLng});out center tags;`
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "User-Agent": "TravelApp-GymFinder-Demo/1.0 (hackathon demo)",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "data=" + encodeURIComponent(query),
  })
  if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`)
  const data = await res.json()
  return data.elements
    .map((el) => ({
      osmId: el.id,
      name: el.tags?.name?.trim() || null,
      lat: el.lat ?? el.center?.lat ?? null,
      lng: el.lon ?? el.center?.lon ?? null,
    }))
    .filter((g) => g.name && g.lat != null && g.lng != null)
}

// Same merge logic as server/index.js's mergeGymsIntoDb - duplicated here
// rather than shared, since this is a standalone script, not a module the
// server imports. Keep both in sync if the merge rule ever changes.
async function mergeGymsIntoDb(gyms) {
  for (const g of gyms) {
    const { rows: legacyMatch } = await pool.query(
      `SELECT id FROM gyms
       WHERE osm_id IS NULL
         AND similarity(name, $1) > 0.6
         AND (6371000 * acos(GREATEST(-1, LEAST(1,
               cos(radians($2)) * cos(radians(lat)) * cos(radians(lng) - radians($3)) +
               sin(radians($2)) * sin(radians(lat))
             )))) < 100
       ORDER BY similarity(name, $1) DESC
       LIMIT 1`,
      [g.name, g.lat, g.lng]
    )
    if (legacyMatch[0]) {
      await pool.query(
        `UPDATE gyms SET osm_id = $1, name = $2, lat = $3, lng = $4, data_source = 'osm' WHERE id = $5`,
        [g.osmId, g.name, g.lat, g.lng, legacyMatch[0].id]
      )
    } else {
      await pool.query(
        `INSERT INTO gyms (osm_id, name, lat, lng, data_source)
         VALUES ($1, $2, $3, $4, 'osm')
         ON CONFLICT (osm_id) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
        [g.osmId, g.name, g.lat, g.lng]
      )
    }
  }
}

function* worldGrid() {
  for (let lat = -90; lat < 90; lat += GRID_DEGREES) {
    for (let lng = -180; lng < 180; lng += GRID_DEGREES) {
      yield { minLat: lat, maxLat: lat + GRID_DEGREES, minLng: lng, maxLng: lng + GRID_DEGREES }
    }
  }
}

async function isFresh(bbox) {
  const { rows } = await pool.query(
    `SELECT last_fetched_at FROM fetched_areas
     WHERE min_lat <= $1 AND max_lat >= $2 AND min_lng <= $3 AND max_lng >= $4
     ORDER BY last_fetched_at DESC LIMIT 1`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng]
  )
  const covering = rows[0]
  return covering && Date.now() - new Date(covering.last_fetched_at).getTime() < AREA_STALE_MS
}

async function main() {
  const budget = Number(process.argv[2]) || DAILY_QUERY_BUDGET
  let queriesUsed = 0
  let chunksCovered = 0
  let chunksSkipped = 0
  let failures = 0

  for (const bbox of worldGrid()) {
    if (queriesUsed >= budget) break
    if (await isFresh(bbox)) {
      chunksSkipped++
      continue
    }

    try {
      const gyms = await fetchOverpassGyms(bbox)
      await mergeGymsIntoDb(gyms)
      await pool.query(
        `INSERT INTO fetched_areas (min_lat, min_lng, max_lat, max_lng) VALUES ($1, $2, $3, $4)`,
        [bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng]
      )
      chunksCovered++
      console.log(
        `Covered [${bbox.minLat},${bbox.minLng}] to [${bbox.maxLat},${bbox.maxLng}] - ${gyms.length} gyms (query ${queriesUsed + 1}/${budget})`
      )
    } catch (e) {
      failures++
      console.error(`Failed [${bbox.minLat},${bbox.minLng}]:`, e.message)
    }
    queriesUsed++ // counts against budget whether it succeeded or failed - it was a real Overpass request either way

    await new Promise((r) => setTimeout(r, jitteredDelay()))
  }

  console.log(
    `\nDone for today. Covered ${chunksCovered}, skipped ${chunksSkipped} (already fresh), ${failures} failures, ${queriesUsed} Overpass queries used.`
  )
  await pool.end()
}

main().catch((e) => {
  console.error("Script failed:", e)
  process.exit(1)
})
