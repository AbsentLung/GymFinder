// Region lookups shared by the gym-region jobs and the read routes.
import { sql } from "drizzle-orm"
import { db } from "./db/index.js"
import { countryNameFromCode } from "./regions.js"

// Smallest wins when polygons overlap (e.g. a territory drawn inside its parent country's region).
export async function findRegionAt(lat: number, lng: number): Promise<{ id: number; name: string; countryCode: string } | null> {
  const found = await db.execute<{ id: number; name: string; country_code: string }>(sql`
    SELECT id, name, country_code FROM regions
    WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ORDER BY ST_Area(geom) ASC LIMIT 1
  `)
  const row = found.rows[0]
  return row ? { id: Number(row.id), name: row.name, countryCode: row.country_code } : null
}

export interface Place {
  region: string | null
  country: string | null
  countryCode: string | null
  postcode: string | null
}

// Country comes from gyms.country_code, so a gym with no region (Photon set the code) still shows its country.
export function placeFromParts(regionName: string | null, countryCode: string | null, postcode: string | null): Place {
  return { region: regionName, country: countryNameFromCode(countryCode), countryCode, postcode }
}

export async function placeForGym(gymId: number): Promise<Place | null> {
  const result = await db.execute<{ region_name: string | null; country_code: string | null; postcode: string | null }>(sql`
    SELECT r.name AS region_name, g.country_code, g.postcode
    FROM gyms g LEFT JOIN regions r ON r.id = g.region_id WHERE g.id = ${gymId}
  `)
  const row = result.rows[0]
  return row ? placeFromParts(row.region_name, row.country_code, row.postcode) : null
}

// For proposals with no gym row yet: a local indexed lookup, not geocoding.
export async function placeAtPoint(lat: number, lng: number): Promise<Place> {
  const region = await findRegionAt(lat, lng)
  return placeFromParts(region?.name ?? null, region?.countryCode ?? null, null)
}

// A gym_changes row's place: its gym's, or for an add_gym with no gym yet, its proposed lat/lng.
export async function placeForChange(gymId: number | null, proposed: unknown): Promise<Place | null> {
  if (gymId) return placeForGym(gymId)
  const p = (proposed ?? {}) as { lat?: unknown; lng?: unknown }
  return typeof p.lat === "number" && typeof p.lng === "number" ? placeAtPoint(p.lat, p.lng) : null
}
