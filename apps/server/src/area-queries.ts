// SQL shared by the boundary seed, the gym-area jobs and the read routes.
import { sql, type SQL } from "drizzle-orm"
import { db } from "./db/index.js"
import { AREA_LEVELS } from "./db/schema.js"
import { AREA_DEPTH, countryNameFromCode } from "./areas.js"

export function areaDepthSql(levelColumn: SQL): SQL {
  const cases = AREA_LEVELS.map((level) => sql`WHEN ${level} THEN ${AREA_DEPTH[level]}`)
  return sql`(CASE ${levelColumn} ${sql.join(cases, sql` `)} END)`
}

// Deepest area whose polygon contains the point; the smallest one wins a
// tie (a promoted territory like Hong Kong sits inside China's polygon).
export function deepestAreaContainingSql(pointSql: SQL): SQL {
  return sql`(
    SELECT a.id FROM areas a
    WHERE ST_Contains(a.geom, ${pointSql})
    ORDER BY ${areaDepthSql(sql`a.level`)} DESC, ST_Area(a.geom) ASC
    LIMIT 1
  )`
}

// Set at insert so price currency is right before the gym-area job runs.
export function countryCodeAtSql(pointSql: SQL): SQL {
  return sql`(SELECT country_code FROM areas WHERE id = ${deepestAreaContainingSql(pointSql)})`
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
  const point = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`
  const result = await db.execute<{ chain: unknown }>(sql`SELECT ${areaChainJsonSql(deepestAreaContainingSql(point))} AS chain`)
  return placeFromChain(result.rows[0]?.chain)
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
