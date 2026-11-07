// Server-side decision input - Photon only, no Nominatim fallback here.
// GeocoderUnavailableError (outage) stays distinct from a plain null
// (Photon answered, found nothing - FR-26's "likely in the sea" signal).
import { photonPlaceFromResponse, type PhotonPlace } from "./regions.js"

export class GeocoderUnavailableError extends Error {}

// A slow Photon response once held a DB transaction open with no bound.
const PHOTON_TIMEOUT_MS = 3000

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`, { signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS) })
  } catch (e) {
    throw new GeocoderUnavailableError(`Photon reverse-geocode unreachable: ${(e as Error).message}`)
  }
  if (!res.ok) throw new GeocoderUnavailableError(`Photon reverse-geocode failed: ${res.status}`)

  const data = await res.json()
  const p = data.features?.[0]?.properties
  return p ? [p.city || p.district, p.state, p.country].filter(Boolean).join(", ") : null
}

// Structured reverse lookup for the gym-region-photon job. Throws on an
// outage so the queue retries; null means Photon found nothing.
export async function reverseGeocodePlace(lat: number, lng: number): Promise<PhotonPlace | null> {
  let res: Response
  try {
    res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`, { signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS) })
  } catch (e) {
    throw new GeocoderUnavailableError(`Photon reverse-geocode unreachable: ${(e as Error).message}`)
  }
  if (!res.ok) throw new GeocoderUnavailableError(`Photon reverse-geocode failed: ${res.status}`)
  return photonPlaceFromResponse(await res.json())
}

// For hint-only callers (a search-query location, not a decision input)
// - an outage there just means a less specific search.
export async function tryReverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    return await reverseGeocode(lat, lng)
  } catch {
    return null
  }
}
