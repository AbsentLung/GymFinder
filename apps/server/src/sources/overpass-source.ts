// Ported from the vibe-coded demo's fetchOverpassGyms (server/index.js) -
// same query, same retry/backoff, same osmTagsToGymFields enrichment,
// just typed and behind the SourceInterface instead of a bare function.
import { osmTagsToGymFields } from "../lib.js"
import type { SourceInterface, RawGym } from "../interfaces/source.js"

const OVERPASS_URL = "https://overpass-api.de/api/interpreter"
const OVERPASS_MAX_ATTEMPTS = 3
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
    for (let attempt = 1; attempt <= OVERPASS_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(OVERPASS_URL, {
          method: "POST",
          headers: {
            "User-Agent": "GymFinder/1.0 (+https://github.com/AbsentLung/GymFinder)",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "data=" + encodeURIComponent(query),
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
              osmId: String(el.id),
              name,
              lat,
              lng,
              ...osmTagsToGymFields(el.tags),
            }
          })
          .filter((g): g is RawGym => g !== null)
      } catch (e) {
        console.error(`Overpass attempt ${attempt}/${OVERPASS_MAX_ATTEMPTS} failed:`, (e as Error).message)
        lastError = e
        if (attempt < OVERPASS_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, OVERPASS_RETRY_DELAY_MS * attempt))
      }
    }
    throw lastError
  }
}
