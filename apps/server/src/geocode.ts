// CLAUDE.md: Photon only - never the public Nominatim server, not even
// as a fallback.
//
// GeocoderUnavailableError (Photon didn't answer) is kept distinct from
// a plain null (Photon answered, found nothing - the "likely in the
// sea" signal FR-26 means) - an outage isn't evidence of anything.
export class GeocoderUnavailableError extends Error {}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`)
  } catch (e) {
    throw new GeocoderUnavailableError(`Photon reverse-geocode unreachable: ${(e as Error).message}`)
  }
  if (!res.ok) throw new GeocoderUnavailableError(`Photon reverse-geocode failed: ${res.status}`)

  const data = await res.json()
  const p = data.features?.[0]?.properties
  return p ? [p.city || p.district, p.state, p.country].filter(Boolean).join(", ") : null
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
