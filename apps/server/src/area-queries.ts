// SQL shared by the boundary seed, the gym-area jobs and the read routes.
import { sql, type SQL } from "drizzle-orm"
import { db } from "./db/index.js"
import { AREA_LEVELS } from "./db/schema.js"
import { AREA_DEPTH, countryNameFromCode } from "./areas.js"

const LEVELS_DEEPEST_FIRST = [...AREA_LEVELS].sort((a, b) => AREA_DEPTH[b] - AREA_DEPTH[a])

// Deepest area whose polygon contains the point. One level at a time,
// deepest first: small city/county polygons answer most lookups, so huge
// country outlines are rarely tested. Smallest wins within a level (a
// promoted territory like Hong Kong sits inside China's polygon).
export async function findDeepestAreaAt(lat: number, lng: number): Promise<{ id: number; countryCode: string } | null> {
  const point = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
  for (const level of LEVELS_DEEPEST_FIRST) {
    const found = await db.execute<{ id: number; country_code: string }>(sql`
      SELECT id, country_code FROM areas WHERE level = ${level} AND ST_Contains(geom, ${point})
      ORDER BY ST_Area(geom) ASC LIMIT 1
    `)
    const row = found.rows[0]
    if (row) return { id: Number(row.id), countryCode: row.country_code }
  }
  return null
}

// jsonb {level: name, ..., country_code} for an area and its ancestors -
// walks parent_id, so names are never copied onto gyms.
export function areaChainJsonSql(areaIdSql: SQL): SQL {
  return sql`(
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, level, name, country_code, 0 AS hop FROM areas WHERE id = ${areaIdSql}
      UNION ALL
      SELECT p.id, p.parent_id, p.level, p.name, p.country_code, chain.hop + 1 FROM areas p JOIN chain ON p.id = chain.parent_id
      WHERE chain.hop < 8
    )
    SELECT jsonb_object_agg(level, name) || jsonb_build_object('country_code', (SELECT country_code FROM chain WHERE hop = 0))
    FROM chain
  )`
}

export interface Place {
  city: string | null
  region: string | null
  county: string | null
  country: string | null
  countryCode: string | null
  postcode: string | null
}

export async function placeForGym(gymId: number): Promise<Place | null> {
  const result = await db.execute<{ chain: unknown; postcode: string | null }>(sql`
    SELECT ${areaChainJsonSql(sql`g.area_id`)} AS chain, g.postcode FROM gyms g WHERE g.id = ${gymId}
  `)
  const row = result.rows[0]
  return row ? placeFromChain(row.chain, row.postcode) : null
}

// For proposals with no gym row yet: a local indexed lookup, not geocoding.
export async function placeAtPoint(lat: number, lng: number): Promise<Place> {
  const area = await findDeepestAreaAt(lat, lng)
  if (!area) return placeFromChain(null)
  const result = await db.execute<{ chain: unknown }>(sql`SELECT ${areaChainJsonSql(sql`${area.id}::bigint`)} AS chain`)
  return placeFromChain(result.rows[0]?.chain)
}

// A gym_changes row's place: its gym's, or for an add_gym with no gym yet, its proposed lat/lng.
export async function placeForChange(gymId: number | null, proposed: unknown): Promise<Place | null> {
  if (gymId) return placeForGym(gymId)
  const p = (proposed ?? {}) as { lat?: unknown; lng?: unknown }
  return typeof p.lat === "number" && typeof p.lng === "number" ? placeAtPoint(p.lat, p.lng) : null
}

export function placeFromChain(chain: unknown, postcode: string | null = null): Place {
  const c = (chain && typeof chain === "object" ? chain : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null)
  const countryCode = str(c.country_code)
  return {
    city: str(c.city),
    region: str(c.region),
    county: str(c.county),
    country: countryNameFromCode(countryCode) ?? str(c.country),
    countryCode,
    postcode,
  }
}
