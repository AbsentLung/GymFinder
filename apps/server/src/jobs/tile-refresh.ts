// Fetches one geohash5 cell from Overpass, merges into `gyms`, and
// records the fetch in tile_fetches either way so a dead cell isn't
// retried on every request.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { geohashToBounds } from "../lib.js"
import { overpassSource } from "../sources/index.js"
import { upsertGym } from "./gym-upsert.js"
import type { RawGym } from "../interfaces/source.js"

export async function refreshTile({ geohash5 }: { geohash5: string }) {
  const bbox = geohashToBounds(geohash5)
  let gyms: RawGym[]
  try {
    gyms = await overpassSource.findGymsInArea(bbox)
  } catch (e) {
    await db.execute(sql`
      INSERT INTO tile_fetches (geohash, source, last_fetched_at, status)
      VALUES (${geohash5}, 'osm', now(), 'failed')
      ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = now(), status = 'failed'
    `)
    throw e
  }

  for (const g of gyms) {
    await upsertGym("osm", g)
  }

  await db.execute(sql`
    INSERT INTO tile_fetches (geohash, source, last_fetched_at, status, gyms_found)
    VALUES (${geohash5}, 'osm', now(), 'ok', ${gyms.length})
    ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = now(), status = 'ok', gyms_found = ${gyms.length}
  `)

  return { gymsFound: gyms.length }
}
