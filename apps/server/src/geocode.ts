// Ported from server/index.js's reverseGeocode - the bot-review
// verification prompt (src/jobs/bot-review.ts) needs a human-readable
// location to fold into its search query, since a gym name alone is
// often not unique worldwide (e.g. "Power Gym"). CLAUDE.md: Photon only
// - never the public Nominatim server, even as a fallback, even in
// MODE=demo (a real production tier, not "dev" - see that file's own
// MODE vs NODE_ENV note).
//
// Two distinct failure shapes, kept distinct rather than both
// collapsing to null: a plain Photon outage shouldn't be treated the
// same as "this coordinate resolves to nowhere real".
// - GeocoderUnavailableError: Photon didn't answer (network error, 5xx,
//   timeout) - callers should NOT treat this as "no location here".
// - null: Photon answered and genuinely found nothing at this point -
//   the real "likely in the sea" signal FR-26 means.
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

// For callers that only use the location as an optional search-query
// hint (verifyFieldChangeForGym, verifyPriceChange) - an outage there
// just means a slightly less specific search, not a reason to fail the
// whole operation, so it collapses to null same as "genuinely no
// location" would.
export async function tryReverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    return await reverseGeocode(lat, lng)
  } catch {
    return null
  }
}
