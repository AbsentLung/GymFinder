// Ported from the vibe-coded demo's server/lib.js (kept there as
// reference only, per the restructure plan) - same pure, dependency-
// free functions, same tests (lib.test.ts), just typed. index.js's
// comments noted a couple of these mirror raw SQL in the old server;
// those SQL equivalents get re-built properly in the sources/requests
// modules rather than copied verbatim.

// No longer Bali-specific - just checks the coordinates are plausible
// at all (a real lat/lng, not e.g. stray 0,0 from a bad client).
export function looksLikeRealCoordinates(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)
}

// 200m + name-similarity > 0.4, both required (STACK_AND_SCHEMA.md
// 2.11's dedup rule for gyms without a shared external id).
export function isDuplicateMatch(distanceKm: number, nameSimilarity: number): boolean {
  return distanceKm < 0.2 && nameSimilarity > 0.4
}

export function isWithinStaleWindow(lastFetchedAt: string | Date, staleMs: number, nowMs = Date.now()): boolean {
  return nowMs - new Date(lastFetchedAt).getTime() < staleMs
}

export interface Bbox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

// "Already covered" is inherently a fuzzy question, not a bit-for-bit
// one - two mathematically-equal floats built via different arithmetic
// don't always land on the identical double, so the comparison itself
// needs slack.
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

// Pure - takes the already-fetched rates object rather than reaching
// into the network/cache layer itself.
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

// Converts a bounding box to the Google Maps @lat,lng,zoom URL zoom
// level that shows roughly that area - the standard web-mercator
// slippy-map relationship.
export function bboxToGoogleMapsZoom(bbox: MapsZoomBbox): number {
  const lngSpan = Math.max(bbox.maxLng - bbox.minLng, 0.0001)
  return Math.max(3, Math.min(17, Math.round(Math.log2(360 / lngSpan))))
}

// A gym can carry several of these at once (STACK_AND_SCHEMA.md 2.8:
// text[] on gyms) - a fixed, generic list instead of whatever free-text
// phrase a scrape happened to produce.
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

// A raw phrase that matches nothing specific falls back to
// "Traditional". A gym with no scraped category text at all gets no
// tags at all, not a Traditional default - that's the "Unknown" case
// the app's own category filter distinguishes from a confirmed plain gym.
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

// OSM's tags are free-form key/value pairs a volunteer mapper chose to
// add. Coverage is inherently inconsistent, so every field here is "use
// it if present," never required.
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

// PostGIS's ST_GeoHash only encodes (lat/lng -> geohash, used for the
// generated geohash4/geohash5 columns); the tiles route needs the
// reverse too, to turn "this geohash4 tile is stale" into an actual
// bbox it can hand to a source's findGymsInArea. Standard geohash
// decode: each base32 character contributes 5 bits, alternating
// between narrowing the longitude and latitude range.
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

// All 32 geohash5 cells inside one geohash4 cell - every geohash
// character appends 5 bits regardless of position, so a parent's
// children at the next precision are exactly itself plus each of the 32
// base32 characters, with no gaps or overlaps.
export function geohash5ChildrenOf(geohash4: string): string[] {
  return GEOHASH_BASE32.split("").map((c) => geohash4 + c)
}
