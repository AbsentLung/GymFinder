// Pure helpers for the `areas` boundaries (LOCATION_NAMES.md): seed-time
// data cleanup and read-time naming. No DB access here.
import { z } from "zod"
import type { AreaLevel } from "./db/schema.js"
import { ISO3_TO_ISO2 } from "./iso-country-codes.js"

export const AREA_DEPTH: Readonly<Record<AreaLevel, number>> = { country: 0, region: 1, county: 2, city: 3 }

// Open licenses whose only duty is attribution (ODbL: share-alike on the
// database, which we already accept for OSM). Anything else is skipped.
const ALLOWED_LICENSE_PATTERNS = [/open database license/i, /^creative commons attribution \d/i, /\(cc by [\d.]+/i, /public domain/i, /\bcc0\b/i]

export function isAllowedBoundaryLicense(license: string): boolean {
  if (/sharealike|share-alike|-sa\b/i.test(license)) return false
  return ALLOWED_LICENSE_PATTERNS.some((p) => p.test(license))
}

export function iso3ToIso2(iso3: string): string | null {
  return ISO3_TO_ISO2[iso3.toUpperCase()] ?? null
}

// CGAZ folds these into their sovereign country, but they have their own
// ISO code (and currency), so the seed promotes them to country level.
export const TERRITORY_OVERRIDES: ReadonlyArray<{ parentIso2: string; name: string; iso2: string }> = [
  { parentIso2: "CN", name: "Hong Kong Special Administrative Region", iso2: "HK" },
  { parentIso2: "CN", name: "Macau Special Administrative Region", iso2: "MO" },
  { parentIso2: "US", name: "Puerto Rico", iso2: "PR" },
  { parentIso2: "US", name: "Guam", iso2: "GU" },
  { parentIso2: "US", name: "American Samoa", iso2: "AS" },
  { parentIso2: "US", name: "Commonwealth of the Northern Mariana Islands", iso2: "MP" },
  { parentIso2: "US", name: "United States Virgin Islands", iso2: "VI" },
  { parentIso2: "FI", name: "Åland Islands", iso2: "AX" },
]

// Windows-1252 code points for bytes 0x80-0x9F; every other byte maps to itself (Latin-1).
const CP1252_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}

// Some geoBoundaries names are UTF-8 that was decoded as Windows-1252
// ("Ã‰VORA" for "ÉVORA"). Re-encode and decode again; leave the name
// alone if it isn't cleanly reversible.
export function fixMojibake(name: string): string {
  if (!/[ÃÂ]/.test(name)) return name
  const bytes: number[] = []
  for (const ch of name) {
    const cp = ch.codePointAt(0)!
    const byte = cp <= 0xff ? cp : CP1252_HIGH[cp]
    if (byte === undefined) return name
    bytes.push(byte)
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    return name
  }
}

export const PhotonReverseSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            countrycode: z.string().optional(),
            state: z.string().optional(),
            county: z.string().optional(),
            city: z.string().optional(),
            district: z.string().optional(),
          })
          .passthrough(),
      })
    )
    .default([]),
})

export interface PhotonPlace {
  countryCode: string | null
  region: string | null
  county: string | null
  city: string | null
}

export function photonPlaceFromResponse(raw: unknown): PhotonPlace | null {
  const parsed = PhotonReverseSchema.safeParse(raw)
  const p = parsed.success ? parsed.data.features[0]?.properties : undefined
  if (!p) return null
  return {
    countryCode: p.countrycode ? p.countrycode.toUpperCase() : null,
    region: p.state ?? null,
    county: p.county ?? null,
    city: p.city ?? p.district ?? null,
  }
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

// Country display name from the code, not the boundary's own label -
// CGAZ uses US State Department style ("Korea, South", "Burma").
export function countryNameFromCode(countryCode: string | null): string | null {
  if (!countryCode) return null
  try {
    const code = countryCode.toUpperCase()
    const name = regionNames.of(code)
    // Unknown codes echo back, except ZZ, CLDR's own "Unknown Region".
    return name && name !== code && code !== "ZZ" ? name : null
  } catch {
    return null
  }
}
