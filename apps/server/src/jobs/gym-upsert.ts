// Shared by every automated source that merges a RawGym into `gyms`
// (dedup via gym_source_refs) - originally written for Overpass refresh
// (src/jobs/tile-refresh.ts), generalized here so a sweep's Google Maps
// source (src/jobs/sweep.ts) can reuse the exact same merge/dedup
// mechanics with a different `source` literal, rather than a second,
// drifting copy of this logic.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { isDuplicateMatch } from "../lib.js"
import type { RawGym } from "../interfaces/source.js"

export async function upsertGym(source: string, g: RawGym): Promise<{ gymId: number; isNew: boolean } | null> {
  if (!g.externalId) return null // every real source supplies one; defensive only.

  const existing = await db.execute<{ gym_id: number }>(sql`
    SELECT gym_id FROM gym_source_refs WHERE source = ${source} AND external_id = ${g.externalId}
  `)

  let gymId: number
  let isNew = false
  if (existing.rows[0]) {
    gymId = existing.rows[0].gym_id
    // name/location: the source is treated as authoritative, same as
    // the old demo's mergeGymsIntoDb. address/description: COALESCE,
    // fill the gap only - never overwrite a better answer the bot/
    // admin/chat already gave.
    await db.execute(sql`
      UPDATE gyms SET name = ${g.name}, location = ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326),
        address = COALESCE(address, ${g.address ?? null}), description = COALESCE(description, ${g.description ?? null})
      WHERE id = ${gymId}
    `)
  } else {
    // A source can map the same real-world gym twice under two
    // different element ids (and two DIFFERENT sources can map the same
    // gym under IDs that share nothing) - a plain external-id match can
    // never catch either case. Caught live in the vibe-coded demo
    // ("Income Gym" mapped twice by OSM, ~4m apart, a permanently-stuck
    // 2-pin map cluster) and fixed there the same way: check
    // name+proximity against every OTHER known gym before inserting,
    // same threshold the rest of this app uses for dedup.
    const nearby = await db.execute<{ gym_id: number; name_similarity: number; distance_km: number }>(sql`
      SELECT r.gym_id, similarity(g.name, ${g.name}) AS name_similarity,
        (6371 * acos(GREATEST(-1, LEAST(1,
          cos(radians(${g.lat})) * cos(radians(ST_Y(g.location))) * cos(radians(ST_X(g.location)) - radians(${g.lng})) +
          sin(radians(${g.lat})) * sin(radians(ST_Y(g.location)))
        )))) AS distance_km
      FROM gym_source_refs r JOIN gyms g ON g.id = r.gym_id
      WHERE NOT (r.source = ${source} AND r.external_id = ${g.externalId})
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
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, ${source}, ${g.externalId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    } else {
      const inserted = await db.execute<{ id: number }>(sql`
        INSERT INTO gyms (name, location, address, description)
        VALUES (${g.name}, ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326), ${g.address ?? null}, ${g.description ?? null})
        RETURNING id
      `)
      gymId = inserted.rows[0].id
      isNew = true
      await db.execute(sql`
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, ${source}, ${g.externalId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    }
  }

  if (g.categories && g.categories.length > 0) {
    // Additive merge (union), never replaces - same rule
    // migrate-demo-data.ts and the old demo both use.
    await db.execute(sql`UPDATE gyms SET categories = ARRAY(SELECT DISTINCT unnest(categories || ${g.categories})) WHERE id = ${gymId}`)
  }

  return { gymId, isNew }
}
