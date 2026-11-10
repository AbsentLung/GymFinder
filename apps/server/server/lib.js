// Pure, dependency-free logic extracted out of index.js so it can be unit
// tested without a live Postgres connection or network access. index.js
// imports from here and calls the SAME functions in production - this is
// not a parallel reimplementation that could quietly drift out of sync.
//
// A few functions here (isBboxCovered, decidePriceRecording) mirror logic
// that also lives in a raw SQL string in index.js, because the real
// production path needs to run as a SQL WHERE clause / UPDATE to use
// Postgres efficiently - JS can't be called from inside SQL. Those are
// explicitly commented where they appear in index.js as "mirrored here
// for testing" - if the SQL changes, these need to change too.

// No longer Bali-specific (docs/gym-data-design.md dropped the fixed
// launch-city model) - just checks the coordinates are plausible at all
// (a real lat/lng, not e.g. stray 0,0 from a bad client).
export function looksLikeRealCoordinates(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)
}

// 200m + name-similarity > 0.4, both required. Loosened from an original
// 100m after confirming live that a real "possible duplicate" flag was
// already correctly proximity-gated (~50m away, same gym with a slightly
// different name) - the threshold logic itself was fine, 200m was just
// the explicitly requested radius.
export function isDuplicateMatch(distanceKm, nameSimilarity) {
  return distanceKm < 0.2 && nameSimilarity > 0.4
}

export function isWithinStaleWindow(lastFetchedAt, staleMs, nowMs = Date.now()) {
  return nowMs - new Date(lastFetchedAt).getTime() < staleMs
}

// Mirrors the epsilon-tolerant containment check in ensureAreaFresh's SQL
// WHERE clause (index.js). Caught live: the exact same "Near me" spot
// re-triggered a full ~35s Overpass refetch because the new bbox's edge
// was -74.03999999999999 against an existing area's -74.04 - the same
// number to any human, but two different floating-point computations
// (one divided a rounded integer by 100, the other subtracted 0.1 from
// that result) don't always land on the identical double. "Already
// covered" is inherently a fuzzy question, not a bit-for-bit one, so the
// comparison itself needs slack - these exact historical values are
// pinned down in the test file so this can't silently regress.
export function isBboxCovered(newBbox, existingBbox, epsilon) {
  return (
    existingBbox.minLat <= newBbox.minLat + epsilon &&
    existingBbox.maxLat >= newBbox.maxLat - epsilon &&
    existingBbox.minLng <= newBbox.minLng + epsilon &&
    existingBbox.maxLng >= newBbox.maxLng - epsilon
  )
}

export function getCountryCurrency(countryCode, countryToCurrency) {
  return countryToCurrency[countryCode] || "USD"
}

// Pure - takes the already-fetched rates object rather than reaching into
// the network/cache layer itself. Caught a real ~20% error here once:
// asked a model to do this conversion by hand (฿200 -> USD) and it got it
// wrong; this is the one place that now does the actual division, so it's
// worth pinning the exact numbers down with a test.
export function convertToUsdCents(amount, currency, rates) {
  if (currency === "USD") return Math.round(amount * 100)
  const rate = rates[currency]
  if (!rate) throw new Error(`Unknown currency code: ${currency}`)
  return Math.round((amount / rate) * 100)
}

// Plan.md's rule: a source confirmed under a year old counts as verified
// (same tier as a human-approved submission) and should land in the
// canonical column travelers see as fact; anything else stays unverified
// pending admin review. Never downgrades an existing admin_verified gym
// back to bot_verified - a bot confirming one field shouldn't erase a
// human's earlier review of this gym. index.js implements this same rule
// as a SQL CASE WHEN inside an atomic UPDATE (so there's no separate
// SELECT-then-decide race window in production); this is that same
// policy, specified as a plain function so it has a direct test.
export function decidePriceRecording(recentSource, currentDataSource) {
  if (!recentSource) return { target: "unverified_gym_data" }
  const dataSource = currentDataSource === "admin_verified" ? "admin_verified" : "bot_verified"
  return { target: "gyms", dataSource }
}

// Google Maps result-list links embed exact coordinates directly in the
// href (e.g. "...!3d18.7992624!4d98.9883932...") - confirmed live against
// a real "gym" category search. Reading this means "find more gyms"
// doesn't need to click into every result to get its location, just
// parse the list once.
export function extractLatLngFromMapsHref(href) {
  const match = href.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/)
  if (!match) return null
  return { lat: Number(match[1]), lng: Number(match[2]) }
}

// Converts a bounding box to the Google Maps @lat,lng,zoom URL zoom level
// that shows roughly that area - the standard web-mercator slippy-map
// relationship (zoom z divides the 360°-wide world into 2^z tiles).
// Clamped to a sane range so an extreme bbox doesn't produce a zoom
// Google Maps would render oddly.
export function bboxToGoogleMapsZoom(bbox) {
  const lngSpan = Math.max(bbox.maxLng - bbox.minLng, 0.0001)
  return Math.max(3, Math.min(17, Math.round(Math.log2(360 / lngSpan))))
}

// A gym can carry several of these at once (gym_categories is a join
// table, not a single column) - a fixed, generic list instead of
// whatever free-text phrase Google happened to scrape, per explicit
// request. Order here is just the canonical display/seed order, not
// meaningful otherwise.
export const GYM_CATEGORIES = [
  "Traditional", "Group", "Yoga", "Bouldering", "Swimming", "Luxury", "MMA", "24hr", "Outdoor", "Sports",
  "CrossFit", "Hyrox", "HIIT", "Personal Trainer", "Pilates",
]

// Keyed by the GYM_CATEGORIES tag it produces. Matched against whatever
// short category phrase Google's own scrape produced (e.g. "Muay Thai
// boxing gym", "CrossFit gym", "Pilates studio") - confirmed against
// every distinct value this app's bot sweep has actually produced so
// far before trusting this list (db: standard, Muay Thai boxing/gym,
// Pilates studio, Strength and conditioning gym, Strength conditioning
// and MMA gym, HIIT gym, Yoga studio, Barre studio, CrossFit gym).
// CrossFit/HIIT/Pilates used to fall under the generic Group bucket -
// pulled out into their own dedicated tags per explicit request, so
// Group is now just the leftover catch-all for other class-based
// formats (barre, generic "group fitness", bootcamp).
const CATEGORY_KEYWORDS = {
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

// A raw phrase that matches nothing specific (the common case - Google's
// own generic "Gym"/"Fitness center"/"Health club" for a plain
// weights-and-machines gym) falls back to "Traditional", the same role
// the old single-category system's "standard" sentinel played. A gym
// with no scraped category text at all gets no tags, not a Traditional
// default - that's the "Unknown" case the frontend's filter already
// distinguishes from an actually-confirmed plain gym.
export function categoriesFromRawText(rawText) {
  if (!rawText) return []
  const matched = Object.entries(CATEGORY_KEYWORDS)
    .filter(([, pattern]) => pattern.test(rawText))
    .map(([tag]) => tag)
  return matched.length > 0 ? matched : ["Traditional"]
}

// OSM's tags are free-form key/value pairs a volunteer mapper chose to
// add - Overpass already returns the full tag set on every gym query
// (fetchOverpassGyms in index.js asks for "out center tags;"), it just
// used to get thrown away except for name. Pulled out as its own
// function since there's real logic worth pinning down with tests:
// joining whichever addr:* parts exist, and splitting+mapping a
// semicolon-separated sport tag (OSM's own convention for "this place
// supports more than one sport/activity", e.g. "sport=yoga;fitness")
// through the same category keywords a scraped phrase would use.
// Coverage is inherently inconsistent - most gyms on OSM have none of
// this, since it's all volunteer-entered - so every field here is
// "use it if present," never a required field.
export function osmTagsToGymFields(tags) {
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

// Returns an error string, or null when valid - lets call sites do
// `const error = validateSignupInput(...); if (error) return res.status(400)...`
// without a separate ok/message shape.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function validateSignupInput({ email, password, name }) {
  if (!name?.trim()) return "Name is required."
  if (!email || !EMAIL_PATTERN.test(email)) return "A valid email is required."
  if (!password || password.length < 8) return "Password must be at least 8 characters."
  return null
}

// Every request type (gym creation, edit, admin application) now requires
// one, per the explicit request that "when a user makes any of these
// requests, they should provide a description" - pulled out as its own
// function since all three submission endpoints need the identical check.
export function requireDescription(description) {
  return description?.trim() ? null : "A description is required."
}
