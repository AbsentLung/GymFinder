// Processes one geohash5 cell: fetch it from Overpass, merge results
// into `gyms` (dedup via gym_source_refs, same shape as
// migrate-demo-data.ts's gym upsert), record the fetch in tile_fetches
// either way (success or failure) so a dead cell doesn't get retried on
// every single tile request that includes it.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { geohashToBounds, isDuplicateMatch } from "../lib.js"
import { overpassSource } from "../sources/index.js"
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
    await upsertGym(g)
  }

  await db.execute(sql`
    INSERT INTO tile_fetches (geohash, source, last_fetched_at, status, gyms_found)
    VALUES (${geohash5}, 'osm', now(), 'ok', ${gyms.length})
    ON CONFLICT (geohash, source) DO UPDATE SET last_fetched_at = now(), status = 'ok', gyms_found = ${gyms.length}
  `)

  return { gymsFound: gyms.length }
}

async function upsertGym(g: RawGym) {
  if (!g.osmId) return // Overpass always supplies one; defensive only.

  const existing = await db.execute<{ gym_id: number }>(sql`
    SELECT gym_id FROM gym_source_refs WHERE source = 'osm' AND external_id = ${g.osmId}
  `)

  let gymId: number
  if (existing.rows[0]) {
    gymId = existing.rows[0].gym_id
    // name/location: OSM is treated as authoritative, same as the old
    // demo's mergeGymsIntoDb. address/description: COALESCE, fill the
    // gap only - never overwrite a better answer the bot/admin/chat
    // already gave.
    await db.execute(sql`
      UPDATE gyms SET name = ${g.name}, location = ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326),
        address = COALESCE(address, ${g.address ?? null}), description = COALESCE(description, ${g.description ?? null})
      WHERE id = ${gymId}
    `)
  } else {
    // OSM itself sometimes maps the same real-world gym twice under two
    // different element ids - a plain osm_id match can never catch that
    // (neither id collides with the other's). Caught live in the
    // vibe-coded demo ("Income Gym" mapped twice, ~4m apart, producing a
    // permanently-stuck 2-pin map cluster) and fixed there the same way:
    // check name+proximity against every OTHER known gym before
    // inserting, same threshold the rest of this app uses for dedup.
    const nearby = await db.execute<{ gym_id: number; name_similarity: number; distance_km: number }>(sql`
      SELECT r.gym_id, similarity(g.name, ${g.name}) AS name_similarity,
        (6371 * acos(GREATEST(-1, LEAST(1,
          cos(radians(${g.lat})) * cos(radians(ST_Y(g.location))) * cos(radians(ST_X(g.location)) - radians(${g.lng})) +
          sin(radians(${g.lat})) * sin(radians(ST_Y(g.location)))
        )))) AS distance_km
      FROM gym_source_refs r JOIN gyms g ON g.id = r.gym_id
      WHERE NOT (r.source = 'osm' AND r.external_id = ${g.osmId})
      ORDER BY distance_km ASC LIMIT 3
    `)
    const duplicate = nearby.rows.find((row) => isDuplicateMatch(row.distance_km, row.name_similarity))

    if (duplicate) {
      gymId = duplicate.gym_id
      await db.execute(sql`
        UPDATE gyms SET address = COALESCE(address, ${g.address ?? null}), description = COALESCE(description, ${g.description ?? null})
        WHERE id = ${gymId}
      `)
      await db.execute(sql`
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, 'osm', ${g.osmId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    } else {
      const inserted = await db.execute<{ id: number }>(sql`
        INSERT INTO gyms (name, location, address, description)
        VALUES (${g.name}, ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326), ${g.address ?? null}, ${g.description ?? null})
        RETURNING id
      `)
      gymId = inserted.rows[0].id
      await db.execute(sql`
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, 'osm', ${g.osmId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    }
  }

  if (g.categories && g.categories.length > 0) {
    // Additive merge (union), never replaces - same rule
    // migrate-demo-data.ts and the old demo both use.
    await db.execute(sql`UPDATE gyms SET categories = ARRAY(SELECT DISTINCT unnest(categories || ${g.categories})) WHERE id = ${gymId}`)
  }
}
