// Server-side decision input - Photon only, no Nominatim fallback here.
// GeocoderUnavailableError (outage) stays distinct from a plain null
// (Photon answered, found nothing - FR-26's "likely in the sea" signal).
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

// ISO 3166-1 alpha-2, for gyms.countryCode - drives which local currency
// a price displays in. Null on an outage, same reasoning as above.
export async function tryReverseGeocodeCountryCode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`)
    if (!res.ok) return null
    const data = await res.json()
    return data.features?.[0]?.properties?.countrycode ?? null
  } catch {
    return null
  }
}
