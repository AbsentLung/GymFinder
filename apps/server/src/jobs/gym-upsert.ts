// Shared merge/dedup logic for every automated source that writes into
// `gyms` (Overpass refresh, a sweep's Google Maps source).
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { isDuplicateMatch } from "../lib.js"
import { findRegionAt } from "../region-queries.js"
import { enqueueGymRegion } from "./gym-region.js"
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
    // name/location: source is authoritative except within a year of an
    // approved admin/bot decision. address/description/postcode: COALESCE only.
    // The CTE sees the row before the update, so `moved` compares old vs new.
    const updated = await db.execute<{ moved: boolean }>(sql`
      WITH before AS (SELECT location FROM gyms WHERE id = ${gymId})
      UPDATE gyms SET
        name = CASE WHEN name_location_decided_at IS NULL OR name_location_decided_at < now() - interval '1 year' THEN ${g.name} ELSE name END,
        location = CASE WHEN name_location_decided_at IS NULL OR name_location_decided_at < now() - interval '1 year'
          THEN ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326) ELSE location END,
        address = COALESCE(address, ${g.address ?? null}), description = COALESCE(description, ${g.description ?? null}),
        postcode = COALESCE(postcode, ${g.postcode ?? null})
      WHERE id = ${gymId}
      RETURNING NOT ST_Equals(gyms.location, (SELECT location FROM before)) AS moved
    `)
    if (updated.rows[0]?.moved) await enqueueGymRegion(gymId)
  } else {
    // A source can map the same real gym under two element ids - plain
    // external-id matching can't catch that, so check name+proximity too.
    const point = sql`ST_SetSRID(ST_MakePoint(${g.lng}, ${g.lat}), 4326)`
    const nearby = await db.execute<{ gym_id: number; name_similarity: number; distance_km: number }>(sql`
      SELECT r.gym_id, similarity(g.name, ${g.name}) AS name_similarity,
        ST_Distance(g.location::geography, ${point}::geography) / 1000 AS distance_km
      FROM gym_source_refs r JOIN gyms g ON g.id = r.gym_id
      WHERE NOT (r.source = ${source} AND r.external_id = ${g.externalId})
        AND ST_DWithin(g.location::geography, ${point}::geography, 500)
      ORDER BY g.location <-> ${point} ASC LIMIT 3
    `)
    const duplicate = nearby.rows.find((row) => isDuplicateMatch(row.distance_km, row.name_similarity))

    if (duplicate) {
      gymId = duplicate.gym_id
      await db.execute(sql`
        UPDATE gyms SET address = COALESCE(address, ${g.address ?? null}), description = COALESCE(description, ${g.description ?? null}),
          postcode = COALESCE(postcode, ${g.postcode ?? null})
        WHERE id = ${gymId}
      `)
      await db.execute(sql`
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, ${source}, ${g.externalId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    } else {
      // Set now so price currency is right before the gym-region job runs.
      const countryCode = (await findRegionAt(g.lat, g.lng))?.countryCode ?? null
      const inserted = await db.execute<{ id: number }>(sql`
        INSERT INTO gyms (name, location, address, description, postcode, country_code)
        VALUES (${g.name}, ${point}, ${g.address ?? null}, ${g.description ?? null}, ${g.postcode ?? null}, ${countryCode})
        RETURNING id
      `)
      gymId = inserted.rows[0].id
      isNew = true
      await enqueueGymRegion(gymId)
      await db.execute(sql`
        INSERT INTO gym_source_refs (gym_id, source, external_id) VALUES (${gymId}, ${source}, ${g.externalId})
        ON CONFLICT (source, external_id) DO NOTHING
      `)
    }
  }

  if (g.categories && g.categories.length > 0) {
    // Additive merge (union), never replaces.
    await db.execute(sql`UPDATE gyms SET categories = ARRAY(SELECT DISTINCT unnest(categories || ${g.categories})) WHERE id = ${gymId}`)
  }

  return { gymId, isNew }
}
