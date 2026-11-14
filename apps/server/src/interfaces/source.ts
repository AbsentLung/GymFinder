// Overpass and the Google Maps scraper both implement this, so
// sweep/refresh code never hardcodes which one it's calling.
export interface RawGym {
  osmId?: string
  name: string
  lat: number
  lng: number
  address?: string | null
  description?: string | null
  categories?: string[]
}

export interface SourceInterface {
  name: string
  findGymsInArea(bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<RawGym[]>
}
