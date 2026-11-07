import { describe, it, expect } from "vitest"
import { countryNameFromCode, fixMojibake, iso3ToIso2, isAllowedBoundaryLicense, photonPlaceFromResponse } from "./areas.js"
import { ISO3_TO_ISO2 } from "./iso-country-codes.js"

describe("isAllowedBoundaryLicense", () => {
  it.each([
    "Open Data Commons Open Database License 1.0",
    "Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO)",
    "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    "Creative Commons Attribution 3.0 License",
    "Public Domain",
    "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication",
  ])("allows %s", (license) => {
    expect(isAllowedBoundaryLicense(license)).toBe(true)
  })

  it.each([
    "Creative Commons Attribution-ShareAlike 2.0",
    "Creative Commons Attribution-ShareAlike 4.0 International License",
    "Other - Direct Permission",
    "Etalab Open License 2.0",
    "Federal Office of Topography swisstopo License",
  ])("skips %s", (license) => {
    expect(isAllowedBoundaryLicense(license)).toBe(false)
  })
})

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

describe("fixMojibake", () => {
  it("repairs UTF-8 read as Windows-1252", () => {
    expect(fixMojibake("Ã‰VORA")).toBe("ÉVORA")
    expect(fixMojibake("RegiÃ£o AutÃ³noma dos AÃ§ores")).toBe("Região Autónoma dos Açores")
  })

  it("leaves correct names alone", () => {
    expect(fixMojibake("Åland Islands")).toBe("Åland Islands")
    expect(fixMojibake("Bali")).toBe("Bali")
  })
})

describe("photonPlaceFromResponse", () => {
  it("picks country code, state, county and city", () => {
    const raw = { features: [{ properties: { countrycode: "id", state: "Bali", county: "Gianyar", city: "Ubud", name: "x" } }] }
    expect(photonPlaceFromResponse(raw)).toEqual({ countryCode: "ID", region: "Bali", county: "Gianyar", city: "Ubud" })
  })

  it("falls back to district for the city", () => {
    const raw = { features: [{ properties: { countrycode: "TH", district: "Pai" } }] }
    expect(photonPlaceFromResponse(raw)?.city).toBe("Pai")
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
