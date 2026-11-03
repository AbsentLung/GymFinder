// Ported from server/index.js's findGoogleMapsGymsInArea - the "find
// more gyms" scrape, generalized behind SourceInterface so sweeps
// (src/jobs/sweep.ts, FR-11) can use it the same way tile-refresh uses
// Overpass. Scrapes the generic "gym" search results list for a
// viewport rather than verifying one specific submitted name/location
// (that's src/llm/tools.ts's find_website_on_google_maps, a different
// capability). Each result link embeds exact coordinates directly in
// its href (extractLatLngFromMapsHref, already confirmed live and
// tested - src/lib.test.ts), so this reads the whole list from one page
// load, no need to click into every result. Google only returns an
// initial page (no scrolling here), so this is bounded to whatever's
// visible on first load - same as a human glancing at the map would see.
import { chromium } from "playwright"
import { extractLatLngFromMapsHref, bboxToGoogleMapsZoom } from "../lib.js"
import type { SourceInterface, RawGym } from "../interfaces/source.js"

const RESULT_LIMIT = 20

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
      const links = await page.locator('a[href*="/maps/place/"]').all()
      const results: RawGym[] = []
      for (const link of links.slice(0, RESULT_LIMIT)) {
        const href = await link.getAttribute("href")
        const name = (await link.innerText().catch(() => "")).trim()
        const coords = href ? extractLatLngFromMapsHref(href) : null
        if (!name || !coords) continue
        results.push({
          // Not Google's own internal place id (not confirmed live
          // against a real page this session, unlike extractLatLngFromMapsHref
          // - a synthetic key was the honest choice over shipping an
          // unverified regex against Google's href format). Coordinates
          // Google reports for the same real place are deterministic
          // across scrapes, so this is still a stable dedup key in
          // practice, just not literally Google's own id.
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
