// Ported from server/index.js's reverseGeocode - the bot-review
// verification prompt (src/jobs/bot-review.ts) needs a human-readable
// location to fold into its search query, since a gym name alone is
// often not unique worldwide (e.g. "Power Gym"). Photon first, Nominatim
// as a fallback - the old demo caught a real, extended Photon outage
// that was silently stalling verification (it has no location to search
// with, correctly refuses to guess, and just gives up).
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&lang=en`)
    if (!res.ok) throw new Error(`Photon reverse failed: ${res.status}`)
    const data = await res.json()
    const p = data.features?.[0]?.properties
    if (p) return [p.city || p.district, p.state, p.country].filter(Boolean).join(", ")
  } catch (e) {
    console.error("Photon reverse-geocode failed, falling back to Nominatim:", (e as Error).message)
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&accept-language=en`,
      { headers: { "User-Agent": "GymFinder/1.0 (bot-review verification)" } }
    )
    if (!res.ok) throw new Error(`Nominatim reverse failed: ${res.status}`)
    const data = await res.json()
    const a = data.address
    if (!a) return null
    return [a.city || a.town || a.village, a.state, a.country].filter(Boolean).join(", ")
  } catch (e) {
    console.error("Nominatim reverse-geocode fallback also failed:", (e as Error).message)
    return null
  }
}
