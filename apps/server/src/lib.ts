// Ported from the vibe-coded demo's server/lib.js - same pure functions,
// just typed.

// Real, plausible lat/lng - not e.g. stray 0,0 from a bad client.
export function looksLikeRealCoordinates(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)
}

// 200m + name-similarity > 0.4, both required.
export function isDuplicateMatch(distanceKm: number, nameSimilarity: number): boolean {
  return distanceKm < 0.2 && nameSimilarity > 0.4
}

export function isWithinStaleWindow(lastFetchedAt: string | Date, staleMs: number, nowMs = Date.now()): boolean {
  return nowMs - new Date(lastFetchedAt).getTime() < staleMs
}

// Short backoff for a failed fetch, so one Overpass 429 doesn't hide a
// cell's gyms for the full normal staleness window.
export const FAILED_FETCH_BACKOFF_MS = 15 * 60 * 1000

export function isFetchRowFresh(
  row: { lastFetchedAt: string | Date; status: string } | undefined,
  staleMs: number,
  nowMs = Date.now()
): boolean {
  if (!row) return false
  return isWithinStaleWindow(row.lastFetchedAt, row.status === "failed" ? FAILED_FETCH_BACKOFF_MS : staleMs, nowMs)
}

export interface Bbox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

// Fuzzy, not exact equality - two equal floats from different arithmetic
// don't always land on the identical double.
export function isBboxCovered(newBbox: Bbox, existingBbox: Bbox, epsilon: number): boolean {
  return (
    existingBbox.minLat <= newBbox.minLat + epsilon &&
    existingBbox.maxLat >= newBbox.maxLat - epsilon &&
    existingBbox.minLng <= newBbox.minLng + epsilon &&
    existingBbox.maxLng >= newBbox.maxLng - epsilon
  )
}

export function getCountryCurrency(countryCode: string, countryToCurrency: Record<string, string>): string {
  return countryToCurrency[countryCode] || "USD"
}

// Pure - takes the already-fetched rates object directly.
export function convertToUsdCents(amount: number, currency: string, rates: Record<string, number>): number {
  if (currency === "USD") return Math.round(amount * 100)
  const rate = rates[currency]
  if (!rate) throw new Error(`Unknown currency code: ${currency}`)
  return Math.round((amount / rate) * 100)
}

// ISO 4217 minor-unit exponent, for a handful of zero-decimal currencies
// this app's own region (SE Asia) actually sees - IDR above all
// (confirmed against API.md's own `gym_prices` examples: a 150000
// "amountMinor" IDR day pass converts to 950 usdCents, which only works
// out ($9.50 for a day pass, 150000 IDR at a realistic rate) if 150000
// IS the whole-Rupiah amount, not 150000 IDR-cents - IDR has no
// subdivision used in practice). Every other currency this app handles
// defaults to 2 (cents, satang, etc.) - the common case.
const ZERO_DECIMAL_CURRENCIES = new Set(["IDR", "JPY", "KRW", "VND", "KHR", "LAK", "MMK"])

export function amountMinorToMajor(amountMinor: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amountMinor : amountMinor / 100
}

// Inverse of amountMinorToMajor - needed wherever a major-unit amount
// comes from somewhere OTHER than our own amountMinor storage (e.g. a
// number the chat LLM reports from a page it read, src/jobs/chat.ts).
export function amountMajorToMinor(amountMajor: number, currency: string): number {
  return Math.round(ZERO_DECIMAL_CURRENCIES.has(currency) ? amountMajor : amountMajor * 100)
}

// Google Maps result-list links embed exact coordinates directly in the
// href (e.g. "...!3d18.7992624!4d98.9883932...").
export function extractLatLngFromMapsHref(href: string): { lat: number; lng: number } | null {
  const match = href.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/)
  if (!match) return null
  return { lat: Number(match[1]), lng: Number(match[2]) }
}

export interface MapsZoomBbox {
  minLng: number
  maxLng: number
}

// Bbox -> the Google Maps @lat,lng,zoom URL level that shows roughly that area.
export function bboxToGoogleMapsZoom(bbox: MapsZoomBbox): number {
  const lngSpan = Math.max(bbox.maxLng - bbox.minLng, 0.0001)
  return Math.max(3, Math.min(17, Math.round(Math.log2(360 / lngSpan))))
}

// A gym can carry several of these at once - a fixed list, not raw scraped text.
export const GYM_CATEGORIES = [
  "Traditional",
  "Group",
  "Yoga",
  "Bouldering",
  "Swimming",
  "Luxury",
  "MMA",
  "24hr",
  "Outdoor",
  "Sports",
  "CrossFit",
  "Hyrox",
  "HIIT",
  "Personal Trainer",
  "Pilates",
] as const

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  Yoga: /yoga/i,
  Bouldering: /boulder|climbing/i,
  Swimming: /swim|aquatic|\bpool\b/i,
  MMA: /\bmma\b|muay thai|boxing|kickbox|jiu-?jitsu|grappl|wrestl|martial arts/i,
  CrossFit: /crossfit/i,
  Hyrox: /hyrox/i,
  HIIT: /\bhiit\b|high[- ]intensity interval/i,
  Pilates: /pilates/i,
  "Personal Trainer": /personal train|1[- ]on[- ]1 training|one-on-one training/i,
  Group: /barre|group fitness|bootcamp|\bclass(es)?\b/i,
  Outdoor: /outdoor|\bpark\b/i,
  Sports: /sports?\s*(club|center|centre)|tennis|basketball|soccer|football/i,
  Luxury: /luxury|premium|exclusive|members[- ]only/i,
  "24hr": /24[- ]?hour|24\/7/i,
}

// No match falls back to "Traditional"; no text at all gets no tags
// ("Unknown", not a Traditional default).
export function categoriesFromRawText(rawText: string | null | undefined): string[] {
  if (!rawText) return []
  const matched = Object.entries(CATEGORY_KEYWORDS)
    .filter(([, pattern]) => pattern.test(rawText))
    .map(([tag]) => tag)
  return matched.length > 0 ? matched : ["Traditional"]
}

export interface OsmTags {
  [key: string]: string | undefined
}

export interface OsmGymFields {
  address: string | null
  description: string | null
  categories: string[]
}

// OSM tags are free-form and inconsistently present - every field here
// is "use it if present," never required.
export function osmTagsToGymFields(tags: OsmTags | null | undefined): OsmGymFields {
  if (!tags) return { address: null, description: null, categories: [] }

  const streetLine = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ")
  const addressParts = [streetLine, tags["addr:city"], tags["addr:postcode"]].filter(Boolean)
  const address = addressParts.length > 0 ? addressParts.join(", ") : null

  const description = tags.description?.trim() || null

  const categories = tags.sport
    ? Array.from(new Set(tags.sport.split(";").flatMap((s) => categoriesFromRawText(s.trim()))))
    : []

  return { address, description, categories }
}

// Returns an error string, or null when valid.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function validateSignupInput({
  email,
  password,
  name,
}: {
  email?: string | null
  password?: string | null
  name?: string | null
}): string | null {
  if (!name?.trim()) return "Name is required."
  if (!email || !EMAIL_PATTERN.test(email)) return "A valid email is required."
  if (!password || password.length < 8) return "Password must be at least 8 characters."
  return null
}

export function requireDescription(description: string | null | undefined): string | null {
  return description?.trim() ? null : "A description is required."
}

// PostGIS only encodes lat/lng -> geohash; this is the reverse, for
// turning a stale tile into a bbox. Standard base32 geohash decode.
const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

export interface GeohashBounds {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export function geohashToBounds(geohash: string): GeohashBounds {
  let minLat = -90
  let maxLat = 90
  let minLng = -180
  let maxLng = 180
  let isEvenBit = true // first bit narrows longitude, by convention

  for (const char of geohash.toLowerCase()) {
    const idx = GEOHASH_BASE32.indexOf(char)
    if (idx === -1) throw new Error(`Invalid geohash character: ${char}`)
    for (let bit = 4; bit >= 0; bit--) {
      const bitValue = (idx >> bit) & 1
      if (isEvenBit) {
        const mid = (minLng + maxLng) / 2
        if (bitValue) minLng = mid
        else maxLng = mid
      } else {
        const mid = (minLat + maxLat) / 2
        if (bitValue) minLat = mid
        else maxLat = mid
      }
      isEvenBit = !isEvenBit
    }
  }
  return { minLat, maxLat, minLng, maxLng }
}

// All 32 geohash5 cells inside one geohash4 cell.
export function geohash5ChildrenOf(geohash4: string): string[] {
  return GEOHASH_BASE32.split("").map((c) => geohash4 + c)
}

// The forward direction geohashToBounds doesn't need (PostGIS's
// ST_GeoHash already covers lat/lng -> geohash for every column in this
// app) but the seeding CLI does (scripts/seed.ts) - turning a
// destination's bounding box into the geohash5 tiles that cover it
// needs encoding arbitrary points, not just decoding a geohash we
// already have. Standard geohash encode: the mirror of
// geohashToBounds's decode loop, narrowing the same lat/lng ranges but
// building up bits instead of reading them off.
export function encodeGeohash(lat: number, lng: number, precision = 5): string {
  let minLat = -90
  let maxLat = 90
  let minLng = -180
  let maxLng = 180
  let isEvenBit = true
  let bit = 0
  let charIdx = 0
  let geohash = ""

  while (geohash.length < precision) {
    if (isEvenBit) {
      const mid = (minLng + maxLng) / 2
      if (lng >= mid) {
        charIdx |= 1 << (4 - bit)
        minLng = mid
      } else {
        maxLng = mid
      }
    } else {
      const mid = (minLat + maxLat) / 2
      if (lat >= mid) {
        charIdx |= 1 << (4 - bit)
        minLat = mid
      } else {
        maxLat = mid
      }
    }
    isEvenBit = !isEvenBit
    if (bit < 4) {
      bit++
    } else {
      geohash += GEOHASH_BASE32[charIdx]
      bit = 0
      charIdx = 0
    }
  }
  return geohash
}

// Grid-walks a bbox at half a geohash5 cell's own span - oversamples on
// purpose (duplicates are deduped by the Set) so a thin sliver of a
// cell near the bbox's edge is never skipped the way stepping by one
// full cell-width could, since geohash5's grid isn't aligned to the
// bbox's own corner.
export function geohash5TilesCoveringBbox(bbox: Bbox): string[] {
  const sample = geohashToBounds(encodeGeohash(bbox.minLat, bbox.minLng, 5))
  const latStep = (sample.maxLat - sample.minLat) / 2
  const lngStep = (sample.maxLng - sample.minLng) / 2
  const tiles = new Set<string>()

  for (let lat = bbox.minLat; lat <= bbox.maxLat; lat += latStep) {
    for (let lng = bbox.minLng; lng <= bbox.maxLng; lng += lngStep) {
      tiles.add(encodeGeohash(lat, lng, 5))
    }
    tiles.add(encodeGeohash(lat, bbox.maxLng, 5))
  }
  tiles.add(encodeGeohash(bbox.maxLat, bbox.maxLng, 5))
  return [...tiles]
}
