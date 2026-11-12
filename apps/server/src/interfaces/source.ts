// Overpass and the Google Maps scraper both implement this, so
// sweep/refresh code never hardcodes which one it's calling.
export interface RawGym {
  // Caller-supplied, per-source - gym_source_refs(source, external_id)
  // is what ties a RawGym back to a specific gyms row across refreshes.
  externalId?: string
  name: string
  lat: number
  lng: number
  address?: string | null
  description?: string | null
  categories?: string[]
  /** Only when the source has a structured one (OSM addr:postcode); never parsed from free text. */
  postcode?: string | null
}

export interface SourceInterface {
  name: string
  findGymsInArea(bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<RawGym[]>
}
