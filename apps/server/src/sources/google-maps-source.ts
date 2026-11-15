// "Find more gyms" - the generic "gym" search for a viewport, not the
// single-gym lookup in llm/tools.ts. Bounded to the first-load results.
import { chromium } from "playwright"
import { extractLatLngFromMapsHref, bboxToGoogleMapsZoom } from "../lib.js"
import type { SourceInterface, RawGym } from "../interfaces/source.js"

const RESULT_LIMIT = 20

// Thrown distinctly from a generic scrape failure so sweep.ts can tell
// "Google is blocking us" apart from "this one request errored" and
// actually back off.
export class GoogleMapsBlockedError extends Error {}

function isBlockedPage(url: string, bodyText: string): boolean {
  if (url.includes("consent.google.com") || url.includes("/sorry/")) return true
  const lower = bodyText.toLowerCase()
  return lower.includes("unusual traffic") || lower.includes("before you continue to maps") || lower.includes("recaptcha")
}

export const googleMapsSource: SourceInterface = {
  name: "google_maps",
  async findGymsInArea(bbox): Promise<RawGym[]> {
    const centerLat = (bbox.minLat + bbox.maxLat) / 2
    const centerLng = (bbox.minLng + bbox.maxLng) / 2
    const zoom = bboxToGoogleMapsZoom(bbox)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(`https://www.google.com/maps/search/gym/@${centerLat},${centerLng},${zoom}z?hl=en`, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      })
      await page.waitForTimeout(2000) // result list renders async

      if (isBlockedPage(page.url(), await page.locator("body").innerText().catch(() => ""))) {
        throw new GoogleMapsBlockedError(`Blocked by Google at ${page.url()}`)
      }

      const links = await page.locator('a[href*="/maps/place/"]').all()
      const results: RawGym[] = []
      for (const link of links.slice(0, RESULT_LIMIT)) {
        const href = await link.getAttribute("href")
        const name = (await link.innerText().catch(() => "")).trim()
        const coords = href ? extractLatLngFromMapsHref(href) : null
        if (!name || !coords) continue
        results.push({
          // Synthetic, not Google's own place id - but coordinates are
          // deterministic across scrapes, so still a stable dedup key.
          externalId: `${name}@${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}`,
          name,
          lat: coords.lat,
          lng: coords.lng,
        })
      }
      return results
    } finally {
      await browser.close()
    }
  },
}
