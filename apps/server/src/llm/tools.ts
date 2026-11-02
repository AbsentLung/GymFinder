// Ported from server/ai.js - the research tools bot-review verification
// (src/jobs/bot-review.ts) needs, plus real chat (API.md 2.4b) and
// sweeps later. Deliberately NOT using Anthropic's hosted
// `web_search_20250305` tool the old demo declared for its Claude path:
// that tool runs server-side on Anthropic's infrastructure and has no
// equivalent for Ollama at all, and the old code's own interception
// logic already assumed every tool resolves client-side (its
// INTERCEPTED_TOOL_NAMES/runIntercepted dispatch treats "web_search" as
// a plain tool_use block, which the hosted tool wouldn't even produce).
// Running our own DuckDuckGo-backed search tool identically on both
// providers keeps verification behavior the same regardless of
// AI_PROVIDER/MODE, matching this app's own mode-agnostic-business-logic
// rule, and avoids a second, metered search path to maintain.
import { chromium } from "playwright"
import type { ToolDef } from "../interfaces/llm.js"

function decodeDuckDuckGoRedirect(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com")
    const real = url.searchParams.get("uddg")
    return real ? decodeURIComponent(real) : href
  } catch {
    return href
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

// Scrapes DuckDuckGo's plain-HTML results page (built for non-JS
// clients, no API key needed). result__a and result__snippet links
// always alternate in document order, so a lazy match correctly pairs
// each title with its own snippet.
export async function searchDuckDuckGo(query: string, maxResults = 3): Promise<SearchResult[]> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "GymFinder/1.0 (bot-review verification)" },
    })
    if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`)
    const html = await res.text()
    const blockRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const results: SearchResult[] = []
    let match
    while ((match = blockRegex.exec(html)) && results.length < maxResults) {
      results.push({ title: stripHtml(match[2]), url: decodeDuckDuckGoRedirect(match[1]), snippet: stripHtml(match[3]) })
    }
    return results
  } catch (e) {
    console.error("DuckDuckGo search failed:", (e as Error).message)
    return []
  }
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// 15000, confirmed against a real gym's own single-page site
// (somafightclub.com, ~9600 chars) whose actual price list sat well
// past an earlier, smaller cap - see server/ai.js's original comment
// for the live-caught truncation bug this value fixes.
const FETCH_URL_MAX_CHARS = 15000
const PRICING_LINK_PATTERN = /member|pricing|price|rates?|join|plans|fees?|cost/i

function findPricingLink(html: string, baseUrl: string): string | null {
  const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = linkRegex.exec(html))) {
    const [, href, linkText] = match
    if (PRICING_LINK_PATTERN.test(href) || PRICING_LINK_PATTERN.test(stripHtml(linkText))) {
      try {
        return new URL(href, baseUrl).toString()
      } catch {
        continue
      }
    }
  }
  return null
}

// followPricingLink defaults true but is passed false on the recursive
// call - caps this at exactly one extra hop, never a real crawl.
export async function fetchUrl(url: string, followPricingLink = true): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "GymFinder/1.0 (bot-review verification)" }, redirect: "follow" })
    if (!res.ok) return `Fetch failed: HTTP ${res.status}`
    const contentType = res.headers.get("content-type") || ""
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return `Fetch failed: not a readable page (content-type: ${contentType || "unknown"})`
    }
    const html = await res.text()
    const text = htmlToReadableText(html)
    if (!text) return "Fetched the page, but found no readable text on it."
    let result = text.length > FETCH_URL_MAX_CHARS ? text.slice(0, FETCH_URL_MAX_CHARS) + "…" : text

    if (followPricingLink) {
      const pricingUrl = findPricingLink(html, url)
      if (pricingUrl && pricingUrl !== url) {
        const pricingPageText = await fetchUrl(pricingUrl, false)
        result += `\n\n--- Also found and fetched a likely pricing/membership page linked from that one (${pricingUrl}) ---\n\n${pricingPageText}`
      }
    }
    return result
  } catch (e) {
    return `Fetch failed: ${(e as Error).message}`
  }
}

export const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description: "Search the web for current information. Returns up to 3 results, each with a title, url, and snippet.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}

export const FETCH_URL_TOOL: ToolDef = {
  name: "fetch_url",
  description:
    "Fetch a specific web page and read its actual text content - use this instead of web_search when you already have a specific URL, since search result snippets are short marketing excerpts that usually don't contain the real page content (e.g. a rendered price table). Only call this with a real, complete URL (including https://).",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "The full URL to fetch, including https://" } },
    required: ["url"],
  },
}

// Finds a business's own official website via its Google Maps listing.
// data-item-id="authority" confirmed live (Soma Fight Club ->
// somafightclub.com) before trusting this selector. Deliberately does
// NOT read Google Maps reviews - Google serves automated browsers a
// stripped "limited view" with no reviews tab at all.
async function findWebsiteOnGoogleMaps(name: string, location: string): Promise<string> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(`${name} ${location}`)}/?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    })
    await page.waitForTimeout(1500)
    const websiteHref = await page
      .locator('a[data-item-id="authority"]')
      .first()
      .getAttribute("href")
      .catch(() => null)
    if (!websiteHref) return "Found this on Google Maps, but it has no official website listed there."
    const pageText = await fetchUrl(websiteHref)
    return `Official website per Google Maps: ${websiteHref}\n\n${pageText}`
  } catch (e) {
    return `Couldn't look this up on Google Maps: ${(e as Error).message}`
  } finally {
    await browser.close()
  }
}

export const GOOGLE_MAPS_WEBSITE_TOOL: ToolDef = {
  name: "find_website_on_google_maps",
  description:
    "Look up a business on Google Maps by name and location, and if it lists an official website, fetch that site's actual content (same as fetch_url, just finding the URL for you first). Use this when you don't already have a direct URL. This canNOT read Google Maps reviews - Google blocks automated access to the reviews tab - so don't use it for that.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The gym's name" },
      location: { type: "string", description: "City/region to disambiguate, e.g. 'Canggu, Bali' or 'Brooklyn, NY'" },
    },
    required: ["name", "location"],
  },
}

// Resolved internally by the agent-turn loop in every LLM implementation
// (src/llm/claude-llm.ts, src/llm/ollama-llm.ts), never handed back to
// the caller as a "finding" to dispatch - unlike a caller-defined tool
// (confirm_price_finding etc.), which only the caller knows how to act on.
export const INTERCEPTED_TOOL_NAMES = new Set(["web_search", "fetch_url", "find_website_on_google_maps"])

export async function runIntercepted(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "web_search") return searchDuckDuckGo(input.query as string)
  if (name === "fetch_url") return fetchUrl(input.url as string)
  if (name === "find_website_on_google_maps") return findWebsiteOnGoogleMaps(input.name as string, input.location as string)
  return null
}
