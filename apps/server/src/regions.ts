// Pure helpers for the `regions` boundaries (LOCATION_NAMES.md): seed-time
// data cleanup and read-time naming. No DB access here.
import { z } from "zod"
import { ISO3_TO_ISO2 } from "./iso-country-codes.js"

export function iso3ToIso2(iso3: string): string | null {
  return ISO3_TO_ISO2[iso3.toUpperCase()] ?? null
}

// CGAZ files these regions under their sovereign country, but they have
// their own ISO code (and currency), so the seed gives them that code.
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

// CGAZ .dbf names mix encodings: mostly UTF-8, some Windows-1252
// ("Päijät-Häme"), and the file header claims 1252 for all. The seed
// loads the raw bytes 1:1 as Latin-1, then this decodes each name.
export function decodeDbfText(latin1: string): string {
  if (!/[\u0080-ÿ]/.test(latin1)) return latin1
  const bytes = Uint8Array.from(latin1, (ch) => ch.charCodeAt(0))
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1252").decode(bytes)
  }
}

export const PhotonReverseSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({ countrycode: z.string().optional(), state: z.string().optional() })
          .passthrough(),
      })
    )
    .default([]),
})

export interface PhotonPlace {
  countryCode: string | null
  region: string | null
}

export function photonPlaceFromResponse(raw: unknown): PhotonPlace | null {
  const parsed = PhotonReverseSchema.safeParse(raw)
  const p = parsed.success ? parsed.data.features[0]?.properties : undefined
  if (!p) return null
  return { countryCode: p.countrycode ? p.countrycode.toUpperCase() : null, region: p.state ?? null }
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
