import { describe, it, expect } from "vitest"
import {
  looksLikeRealCoordinates,
  isDuplicateMatch,
  isWithinStaleWindow,
  isFetchRowFresh,
  FAILED_FETCH_BACKOFF_MS,
  isBboxCovered,
  getCountryCurrency,
  convertToUsdCents,
  amountMinorToMajor,
  amountMajorToMinor,
  extractLatLngFromMapsHref,
  bboxToGoogleMapsZoom,
  categoriesFromRawText,
  osmTagsToGymFields,
  validateSignupInput,
  requireDescription,
  geohashToBounds,
  geohash5ChildrenOf,
  encodeGeohash,
  geohash5TilesCoveringBbox,
} from "./lib.js"

describe("looksLikeRealCoordinates", () => {
  it("accepts a real lat/lng", () => {
    expect(looksLikeRealCoordinates(18.79, 98.99)).toBe(true)
  })
  it("rejects out-of-range values", () => {
    expect(looksLikeRealCoordinates(91, 0)).toBe(false)
    expect(looksLikeRealCoordinates(0, 181)).toBe(false)
  })
  it("rejects exactly 0,0 - the classic bad-client sentinel", () => {
    expect(looksLikeRealCoordinates(0, 0)).toBe(false)
  })
})

describe("isDuplicateMatch", () => {
  it("flags a close, similarly-named gym", () => {
    expect(isDuplicateMatch(0.05, 0.5)).toBe(true)
  })
  it("does not flag a similarly-named gym that's too far away", () => {
    expect(isDuplicateMatch(0.25, 0.9)).toBe(false)
  })
  it("does not flag a close gym with a dissimilar name", () => {
    expect(isDuplicateMatch(0.05, 0.3)).toBe(false)
  })
  it("is exclusive at both boundaries", () => {
    expect(isDuplicateMatch(0.2, 0.5)).toBe(false) // distance_km must be < 0.2, not <=
    expect(isDuplicateMatch(0.05, 0.4)).toBe(false) // similarity must be > 0.4, not >=
  })
})

describe("isWithinStaleWindow", () => {
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000
  it("is fresh just under the window", () => {
    const now = Date.now()
    expect(isWithinStaleWindow(new Date(now - oneWeekMs + 1000).toISOString(), oneWeekMs, now)).toBe(true)
  })
  it("is stale just over the window", () => {
    const now = Date.now()
    expect(isWithinStaleWindow(new Date(now - oneWeekMs - 1000).toISOString(), oneWeekMs, now)).toBe(false)
  })
})

describe("isFetchRowFresh", () => {
  const staleMs = 7 * 24 * 60 * 60 * 1000
  it("is not fresh when there's no row at all", () => {
    expect(isFetchRowFresh(undefined, staleMs)).toBe(false)
  })
  it("uses the normal stale window for an ok row", () => {
    const now = Date.now()
    expect(isFetchRowFresh({ lastFetchedAt: new Date(now - staleMs + 1000).toISOString(), status: "ok" }, staleMs, now)).toBe(true)
  })
  it("uses the short backoff window for a failed row, even well inside the normal window", () => {
    const now = Date.now()
    const row = { lastFetchedAt: new Date(now - FAILED_FETCH_BACKOFF_MS - 1000).toISOString(), status: "failed" }
    expect(isFetchRowFresh(row, staleMs, now)).toBe(false) // backoff elapsed - retry allowed
  })
  it("a just-failed row is still fresh (still backing off), not stale for a week", () => {
    const now = Date.now()
    const row = { lastFetchedAt: new Date(now - 1000).toISOString(), status: "failed" }
    expect(isFetchRowFresh(row, staleMs, now)).toBe(true)
  })
})

describe("isBboxCovered", () => {
  const epsilon = 0.0001

  it("covers an exact match", () => {
    const box = { minLat: 40.58, maxLat: 40.78, minLng: -74.04, maxLng: -73.84 }
    expect(isBboxCovered(box, box, epsilon)).toBe(true)
  })

  it("covers the exact historical float-precision bug values", () => {
    const stored = { minLat: 40.58, maxLat: 40.78, minLng: -74.03999999999999, maxLng: -73.84 }
    const requested = { minLat: 40.58, maxLat: 40.78, minLng: -74.04, maxLng: -73.84 }
    expect(isBboxCovered(requested, stored, epsilon)).toBe(true)
  })

  it("does not cover a genuinely different area", () => {
    const stored = { minLat: 40.58, maxLat: 40.78, minLng: -74.04, maxLng: -73.84 }
    const requested = { minLat: 51.4, maxLat: 51.6, minLng: -0.2, maxLng: 0.0 } // London
    expect(isBboxCovered(requested, stored, epsilon)).toBe(false)
  })
})

describe("getCountryCurrency", () => {
  const map = { TH: "THB", US: "USD" }
  it("returns the mapped currency", () => {
    expect(getCountryCurrency("TH", map)).toBe("THB")
  })
  it("falls back to USD for an unmapped country", () => {
    expect(getCountryCurrency("ZZ", map)).toBe("USD")
  })
})

describe("convertToUsdCents", () => {
  it("passes USD straight through as cents", () => {
    expect(convertToUsdCents(15, "USD", {})).toBe(1500)
  })
  it("converts a real rate correctly", () => {
    expect(convertToUsdCents(200, "THB", { THB: 33.758724 })).toBe(592)
  })
  it("throws on an unknown currency rather than silently guessing", () => {
    expect(() => convertToUsdCents(100, "ZZZ", { THB: 33.76 })).toThrow()
  })
})

describe("amountMinorToMajor", () => {
  it("divides by 100 for a normal (2-decimal) currency", () => {
    expect(amountMinorToMajor(1500, "USD")).toBe(15)
  })
  it("passes a zero-decimal currency straight through - confirmed against API.md's own gym_prices example (150000 IDR amountMinor -> 950 usdCents, a realistic ~$9.50 day pass)", () => {
    expect(amountMinorToMajor(150000, "IDR")).toBe(150000)
  })
})

describe("amountMajorToMinor", () => {
  it("is the exact inverse of amountMinorToMajor for a normal currency", () => {
    expect(amountMajorToMinor(amountMinorToMajor(1500, "USD"), "USD")).toBe(1500)
  })
  it("is the exact inverse of amountMinorToMajor for a zero-decimal currency", () => {
    expect(amountMajorToMinor(amountMinorToMajor(150000, "IDR"), "IDR")).toBe(150000)
  })
})

describe("extractLatLngFromMapsHref", () => {
  it("parses a real Google Maps result href", () => {
    const href =
      "https://www.google.com/maps/place/PUMP+FITNESS/data=!4m7!3m6!1s0x30da3b0455aedd45:0x7b2a3f76e3545eb2!8m2!3d18.7992624!4d98.9883932!16s%2Fg%2F11fjxdz0wk"
    expect(extractLatLngFromMapsHref(href)).toEqual({ lat: 18.7992624, lng: 98.9883932 })
  })
  it("parses negative coordinates correctly", () => {
    const href = "https://www.google.com/maps/place/Foo/data=!4m2!3m1!8m2!3d-8.667761!4d115.1693746"
    expect(extractLatLngFromMapsHref(href)).toEqual({ lat: -8.667761, lng: 115.1693746 })
  })
  it("returns null when the pattern isn't present", () => {
    expect(extractLatLngFromMapsHref("https://www.google.com/maps/search/gym")).toBeNull()
  })
})

describe("bboxToGoogleMapsZoom", () => {
  it("returns a higher zoom for a smaller area", () => {
    const city = bboxToGoogleMapsZoom({ minLng: 98.9, maxLng: 99.1 })
    const country = bboxToGoogleMapsZoom({ minLng: 97, maxLng: 105 })
    expect(city).toBeGreaterThan(country)
  })
  it("clamps to the sane range for an extreme bbox", () => {
    expect(bboxToGoogleMapsZoom({ minLng: -180, maxLng: 180 })).toBeGreaterThanOrEqual(3)
    expect(bboxToGoogleMapsZoom({ minLng: 98.98, maxLng: 98.9801 })).toBeLessThanOrEqual(17)
  })
})

describe("categoriesFromRawText", () => {
  it("maps a generic Google category to the Traditional fallback", () => {
    expect(categoriesFromRawText("Gym")).toEqual(["Traditional"])
    expect(categoriesFromRawText("Fitness center")).toEqual(["Traditional"])
    expect(categoriesFromRawText("Health club")).toEqual(["Traditional"])
  })
  it("maps specific real-world scraped phrases to the right tag", () => {
    expect(categoriesFromRawText("Muay Thai boxing gym")).toEqual(["MMA"])
    expect(categoriesFromRawText("Yoga studio")).toEqual(["Yoga"])
    expect(categoriesFromRawText("CrossFit gym")).toEqual(["CrossFit"])
    expect(categoriesFromRawText("Pilates studio")).toEqual(["Pilates"])
    expect(categoriesFromRawText("HIIT gym")).toEqual(["HIIT"])
    expect(categoriesFromRawText("Hyrox training")).toEqual(["Hyrox"])
    expect(categoriesFromRawText("Personal training studio")).toEqual(["Personal Trainer"])
    expect(categoriesFromRawText("Barre studio")).toEqual(["Group"])
  })
  it("can match more than one tag at once", () => {
    expect(categoriesFromRawText("Strength conditioning and MMA gym")).toEqual(["MMA"])
    expect(categoriesFromRawText("Boxing, Kickboxing, Muay Thai, Brazilian Jiu-Jitsu, MMA, and Grappling Gym")).toEqual(["MMA"])
  })
  it("returns no tags at all for no category, not the Traditional fallback", () => {
    expect(categoriesFromRawText(null)).toEqual([])
    expect(categoriesFromRawText("")).toEqual([])
  })
})

describe("osmTagsToGymFields", () => {
  it("joins whichever addr:* parts are present", () => {
    expect(
      osmTagsToGymFields({ "addr:housenumber": "12", "addr:street": "Main St", "addr:city": "Springfield", "addr:postcode": "90210" })
    ).toEqual({ address: "12 Main St, Springfield, 90210", description: null, categories: [] })
  })
  it("still joins the parts that do exist when others are missing", () => {
    expect(osmTagsToGymFields({ "addr:city": "Springfield" })).toEqual({ address: "Springfield", description: null, categories: [] })
  })
  it("picks up a description tag when present", () => {
    expect(osmTagsToGymFields({ description: " A great gym " })).toEqual({ address: null, description: "A great gym", categories: [] })
  })
  it("maps a single sport tag to its category", () => {
    expect(osmTagsToGymFields({ sport: "yoga" })).toEqual({ address: null, description: null, categories: ["Yoga"] })
  })
  it("splits a semicolon-separated sport tag and maps each part", () => {
    const result = osmTagsToGymFields({ sport: "yoga;climbing" })
    expect(result.categories.sort()).toEqual(["Bouldering", "Yoga"])
  })
  it("returns all-empty defaults for no tags at all", () => {
    expect(osmTagsToGymFields(null)).toEqual({ address: null, description: null, categories: [] })
    expect(osmTagsToGymFields({})).toEqual({ address: null, description: null, categories: [] })
  })
})

describe("validateSignupInput", () => {
  const valid = { email: "a@b.com", password: "longenough", name: "Ann" }
  it("accepts valid input", () => {
    expect(validateSignupInput(valid)).toBeNull()
  })
  it("rejects a missing name", () => {
    expect(validateSignupInput({ ...valid, name: "  " })).toMatch(/name/i)
  })
  it("rejects a malformed email", () => {
    expect(validateSignupInput({ ...valid, email: "not-an-email" })).toMatch(/email/i)
  })
  it("rejects a short password", () => {
    expect(validateSignupInput({ ...valid, password: "short" })).toMatch(/password/i)
  })
})

describe("requireDescription", () => {
  it("accepts a non-empty description", () => {
    expect(requireDescription("Found this gym on a run")).toBeNull()
  })
  it("rejects missing or whitespace-only descriptions", () => {
    expect(requireDescription(undefined)).toMatch(/description/i)
    expect(requireDescription("   ")).toMatch(/description/i)
  })
})

describe("geohashToBounds", () => {
  it("decodes a real geohash5 back to roughly its source point", () => {
    // "qw3yu" is PostGIS's own ST_GeoHash(location, 5) for lng=115.1385,
    // lat=-8.6501 (Bali) - confirmed live against a real Postgres+PostGIS
    // instance in Phase 3 (ST_GeoHash(ST_MakePoint(115.1385, -8.6501),5)
    // = "qw3yu"). Decoding it back should bracket that same point.
    const bounds = geohashToBounds("qw3yu")
    expect(bounds.minLat).toBeLessThanOrEqual(-8.6501)
    expect(bounds.maxLat).toBeGreaterThanOrEqual(-8.6501)
    expect(bounds.minLng).toBeLessThanOrEqual(115.1385)
    expect(bounds.maxLng).toBeGreaterThanOrEqual(115.1385)
  })
  it("rejects an invalid character", () => {
    expect(() => geohashToBounds("qwa")).toThrow() // 'a' is not in the base32 alphabet
  })
})

describe("encodeGeohash", () => {
  it("matches PostGIS's own ST_GeoHash for the real Bali point confirmed live in Phase 3", () => {
    expect(encodeGeohash(-8.6501, 115.1385, 5)).toBe("qw3yu")
  })
  it("round-trips through geohashToBounds for an arbitrary real point", () => {
    // Soma Fight Club, src/jobs/bot-review.ts's own live-verified test
    // gym this session.
    const lat = -8.6436827
    const lng = 115.1573287
    const hash = encodeGeohash(lat, lng, 5)
    const bounds = geohashToBounds(hash)
    expect(bounds.minLat).toBeLessThanOrEqual(lat)
    expect(bounds.maxLat).toBeGreaterThanOrEqual(lat)
    expect(bounds.minLng).toBeLessThanOrEqual(lng)
    expect(bounds.maxLng).toBeGreaterThanOrEqual(lng)
  })
})

describe("geohash5TilesCoveringBbox", () => {
  it("covers a bbox the size of a few geohash5 cells with no gaps", () => {
    const bounds = geohashToBounds("qw3yu")
    const latSpan = bounds.maxLat - bounds.minLat
    const lngSpan = bounds.maxLng - bounds.minLng
    // A bbox 3 cells wide and 3 cells tall, centered on qw3yu.
    const bbox = {
      minLat: bounds.minLat - latSpan,
      maxLat: bounds.maxLat + latSpan,
      minLng: bounds.minLng - lngSpan,
      maxLng: bounds.maxLng + lngSpan,
    }
    const tiles = geohash5TilesCoveringBbox(bbox)
    expect(tiles).toContain("qw3yu")
    // Every corner of the bbox must land in a returned tile - the real
    // failure mode a too-large step size would produce is a corner
    // silently falling outside every returned cell.
    expect(tiles).toContain(encodeGeohash(bbox.minLat, bbox.minLng, 5))
    expect(tiles).toContain(encodeGeohash(bbox.maxLat, bbox.maxLng, 5))
    expect(tiles.length).toBeGreaterThanOrEqual(9) // at least the 3x3 grid of cells
  })
})

describe("geohash5ChildrenOf", () => {
  it("returns exactly 32 children, each the parent plus one character", () => {
    const children = geohash5ChildrenOf("qw3y")
    expect(children).toHaveLength(32)
    expect(new Set(children).size).toBe(32) // all distinct
    for (const c of children) expect(c.startsWith("qw3y")).toBe(true)
    expect(children).toContain("qw3yu") // the real geohash5 cell confirmed in Phase 3
  })
})
