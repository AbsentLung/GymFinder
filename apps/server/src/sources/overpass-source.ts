// Ported from the vibe-coded demo's fetchOverpassGyms - same query/retry,
// now behind SourceInterface.
import { osmTagsToGymFields } from "../lib.js"
import type { SourceInterface, RawGym } from "../interfaces/source.js"

// Independently-run mirrors of the same Overpass software/data - one
// attempt per mirror, so one host's outage doesn't sink every sweep.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
]
const OVERPASS_TIMEOUT_MS = 15000
const OVERPASS_RETRY_DELAY_MS = 4000

interface OverpassElement {
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export class OverpassSource implements SourceInterface {
  name = "osm"

  async findGymsInArea(bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<RawGym[]> {
    const query = `[out:json];nwr["leisure"="fitness_centre"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});out center tags;`
    let lastError: unknown
    for (let attempt = 1; attempt <= OVERPASS_URLS.length; attempt++) {
      const url = OVERPASS_URLS[attempt - 1]
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "User-Agent": "GymFinder/1.0 (+https://github.com/AbsentLung/GymFinder)",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`)
        const data = (await res.json()) as { elements: OverpassElement[] }
        return data.elements
          .map((el): RawGym | null => {
            const lat = el.lat ?? el.center?.lat ?? null
            const lng = el.lon ?? el.center?.lon ?? null
            const name = el.tags?.name?.trim() || null
            if (!name || lat == null || lng == null) return null
            return {
              externalId: String(el.id),
              name,
              lat,
              lng,
              ...osmTagsToGymFields(el.tags),
            }
          })
          .filter((g): g is RawGym => g !== null)
      } catch (e) {
        console.error(`Overpass attempt ${attempt}/${OVERPASS_URLS.length} (${url}) failed:`, (e as Error).message)
        lastError = e
        if (attempt < OVERPASS_URLS.length) await new Promise((r) => setTimeout(r, OVERPASS_RETRY_DELAY_MS))
      }
    }
    throw lastError
  }
}
