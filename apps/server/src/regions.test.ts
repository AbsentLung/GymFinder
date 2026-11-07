import { describe, it, expect } from "vitest"
import { countryNameFromCode, decodeDbfText, iso3ToIso2, photonPlaceFromResponse } from "./regions.js"
import { ISO3_TO_ISO2 } from "./iso-country-codes.js"

describe("iso3ToIso2", () => {
  it("maps known codes, case-insensitively", () => {
    expect(iso3ToIso2("IDN")).toBe("ID")
    expect(iso3ToIso2("xkx")).toBe("XK")
  })

  it("returns null for CGAZ's numeric disputed-area codes", () => {
    expect(iso3ToIso2("112")).toBeNull()
  })

  it("has unique two-letter targets", () => {
    const values = Object.values(ISO3_TO_ISO2)
    expect(values.every((v) => /^[A-Z]{2}$/.test(v))).toBe(true)
    expect(new Set(values).size).toBe(values.length)
  })
})

// What shp2pgsql -W LATIN1 hands back: one char per raw byte.
const asLatin1 = (bytes: Buffer) => bytes.toString("latin1")

describe("decodeDbfText", () => {
  it("decodes names stored as UTF-8", () => {
    expect(decodeDbfText(asLatin1(Buffer.from("ÉVORA", "utf-8")))).toBe("ÉVORA")
    expect(decodeDbfText(asLatin1(Buffer.from("Região Autónoma dos Açores", "utf-8")))).toBe("Região Autónoma dos Açores")
    expect(decodeDbfText(asLatin1(Buffer.from("เชียงใหม่", "utf-8")))).toBe("เชียงใหม่")
  })

  it("decodes names stored as Windows-1252", () => {
    expect(decodeDbfText(asLatin1(Buffer.from("Päijät-Häme", "latin1")))).toBe("Päijät-Häme")
    // 0x96 is an en dash in Windows-1252 (a control character in Latin-1).
    expect(decodeDbfText(asLatin1(Buffer.from([0x41, 0x96, 0x42])))).toBe("A–B")
  })

  it("leaves plain ASCII alone", () => {
    expect(decodeDbfText("Bali")).toBe("Bali")
  })
})

describe("photonPlaceFromResponse", () => {
  it("picks the country code and the state as region", () => {
    const raw = { features: [{ properties: { countrycode: "id", state: "Bali", city: "Ubud", name: "x" } }] }
    expect(photonPlaceFromResponse(raw)).toEqual({ countryCode: "ID", region: "Bali" })
  })

  it("keeps the country code when there is no state", () => {
    const raw = { features: [{ properties: { countrycode: "SG" } }] }
    expect(photonPlaceFromResponse(raw)).toEqual({ countryCode: "SG", region: null })
  })

  it("returns null for no features or a malformed body", () => {
    expect(photonPlaceFromResponse({ features: [] })).toBeNull()
    expect(photonPlaceFromResponse("nope")).toBeNull()
  })
})

describe("countryNameFromCode", () => {
  it("gives the English name", () => {
    expect(countryNameFromCode("KR")).toBe("South Korea")
    expect(countryNameFromCode("id")).toBe("Indonesia")
  })

  it("returns null for null or unknown codes", () => {
    expect(countryNameFromCode(null)).toBeNull()
    expect(countryNameFromCode("ZZ")).toBeNull()
  })
})
