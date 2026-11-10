// Provider abstraction for every LLM call in this app - lets AI_PROVIDER
// switch between the real Anthropic API (production) and a free local
// Ollama model (development, to avoid metered API spend while iterating)
// without touching any of the business logic at the four call sites in
// index.js. Both paths are kept side by side on purpose, not one
// replacing the other - production is expected to flip back to
// "anthropic" via the env var alone.
import Anthropic from "@anthropic-ai/sdk"
import { Ollama } from "ollama"
import { chromium } from "playwright"

const AI_PROVIDER = process.env.AI_PROVIDER === "ollama" ? "ollama" : "anthropic"
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b"

const anthropic = new Anthropic() // reads ANTHROPIC_API_KEY - unused when AI_PROVIDER=ollama
const ollama = new Ollama({ host: process.env.OLLAMA_HOST || "http://localhost:11434" })

// Decodes DuckDuckGo's own "/l/?uddg=<encoded-real-url>" redirect links
// back to the real target - without this, source_url fields (shown to a
// human reviewer, or used as the citation for a price finding) would all
// point at duckduckgo.com instead of the actual source.
function decodeDuckDuckGoRedirect(href) {
  try {
    const url = new URL(href, "https://duckduckgo.com")
    const real = url.searchParams.get("uddg")
    return real ? decodeURIComponent(real) : href
  } catch {
    return href
  }
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim()
}

// Anthropic's web_search tool is hosted - Anthropic runs the actual
// search server-side and the results come back already resolved inside
// the same API response, no code on this end involved. Ollama has no
// such thing, so this is that same capability built by hand: scrapes
// DuckDuckGo's own plain-HTML results page (the one built for non-JS
// clients, no API key or signup needed - genuinely free). Confirmed live
// against a real query before trusting this regex; result__a and
// result__snippet links always alternate in document order (one block's
// title immediately followed, eventually, by that same block's snippet,
// with no other result__a in between) so a lazy match correctly pairs
// each title with its own snippet rather than a neighboring result's.
async function searchDuckDuckGo(query, maxResults = 3) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "TravelApp-GymFinder-Demo/1.0 (hackathon demo)" },
    })
    if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`)
    const html = await res.text()
    const blockRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const results = []
    let match
    while ((match = blockRegex.exec(html)) && results.length < maxResults) {
      results.push({
        title: stripHtml(match[2]),
        url: decodeDuckDuckGoRedirect(match[1]),
        snippet: stripHtml(match[3]),
      })
    }
    return results
  } catch (e) {
    console.error("DuckDuckGo search failed:", e.message)
    return []
  }
}

// Strips <script>/<style> blocks ENTIRELY first (their text content is
// never real page content - leaving them in would feed raw JS/CSS to
// the model instead of what a visitor actually sees), then every other
// tag, then collapses the runs of blank space tag-stripping leaves
// behind so the result reads like plain text, not one page-long line.
function htmlToReadableText(html) {
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

// The actual fix for "I gave the bot a link and it still couldn't find
// the price" - confirmed live that web_search's own result snippets are
// short SEO-description-style excerpts (e.g. "Join and enjoy 28 days...")
// that never contain a page's real content like a rendered price table,
// even when the exact right URL is among the search results. This
// fetches the real page and hands over its actual text instead of a
// snippet - a genuinely different capability from search, not a better
// prompt for the same one.
//
// 15000, not a smaller "surely enough" guess - caught live on a real
// gym's own single-page site (somafightclub.com): its actual price list
// ("Daily Rp375,000...") sits in plain text at around character 8400,
// after a long schedule/bio section earlier on the page. An 8000-char
// cap (the first attempt here) truncated the page one paragraph before
// the price table and the local model, having read right up to the
// truncation point and found nothing, gave up rather than suspecting
// there was more below it. 15000 comfortably covers that real page (it's
// ~9600 chars in full) with room for a longer one; a flat truncation can
// still in principle miss content further down an unusually long page,
// a real limitation worth knowing about rather than solving with a
// smarter (and much more complex) extractor right now.
const FETCH_URL_MAX_CHARS = 15000

// After fetching a page, also check whether it links to a more specific
// pricing/membership page and, if so, follow that ONE link automatically
// rather than relying on the model to notice and ask for it itself.
// Confirmed live as a real, repeatable gap: fetching a gym's homepage
// directly often shows only nav links ("Membership", "Join") with the
// actual price one click away, and the free local model's follow-
// through wasn't reliable enough to take that obvious next step on its
// own - it read the homepage, saw no number, and just gave up instead of
// following the "Membership" link sitting right there in what it had
// just read. Matching on the link text OR the href catches cases where
// one is generic ("Learn more") but the other gives it away.
const PRICING_LINK_PATTERN = /member|pricing|price|rates?|join|plans|fees?|cost/i

function findPricingLink(html, baseUrl) {
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
// call below - caps this at exactly one extra hop, never a real crawl.
async function fetchUrl(url, followPricingLink = true) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "TravelApp-GymFinder-Demo/1.0 (hackathon demo)" },
      redirect: "follow",
    })
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
    return `Fetch failed: ${e.message}`
  }
}

// Canonical shape for this tool - declared here (not duplicated in every
// CHAT_TOOLS/EDIT_VERIFICATION_TOOLS array in index.js) since the
// execution lives here too; index.js just spreads this into whichever
// tool array should offer it.
export const FETCH_URL_TOOL = {
  name: "fetch_url",
  description:
    "Fetch a specific web page and read its actual text content - use this instead of web_search when you (or the traveler) already have a specific URL, since search result snippets are short marketing excerpts that usually don't contain the real page content (e.g. a rendered price table). Only call this with a real, complete URL (including https://).",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "The full URL to fetch, including https://" } },
    required: ["url"],
  },
}

// Finds a business's own official website via its Google Maps listing,
// then reads it the same way fetch_url does - often faster at landing on
// a gym's own site specifically than a generic web search, since this
// goes through the same listing the bot sweep/find-more-gyms already
// resolve places through. data-item-id="authority" confirmed live
// against a real listing (Soma Fight Club -> somafightclub.com) before
// trusting this selector.
//
// Deliberately does NOT attempt to read Google Maps reviews - confirmed
// earlier in this project (findGoogleMapsMatch's own comment) that
// Google serves automated browsers a stripped "limited view" of a
// listing with no reviews tab at all, so there's nothing there for this
// to scrape even if it tried.
async function findWebsiteOnGoogleMaps(name, location) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(`${name} ${location}`)}/?hl=en`, {
      waitUntil: "domcontentloaded",
      timeout: 8000,
    })
    await page.waitForTimeout(1500)
    const websiteHref = await page.locator('a[data-item-id="authority"]').first().getAttribute("href").catch(() => null)
    if (!websiteHref) return "Found this on Google Maps, but it has no official website listed there."
    const pageText = await fetchUrl(websiteHref)
    return `Official website per Google Maps: ${websiteHref}\n\n${pageText}`
  } catch (e) {
    return `Couldn't look this up on Google Maps: ${e.message}`
  } finally {
    await browser.close()
  }
}

export const GOOGLE_MAPS_WEBSITE_TOOL = {
  name: "find_website_on_google_maps",
  description:
    "Look up a business on Google Maps by name and location, and if it lists an official website, fetch that site's actual content (same as fetch_url, just finding the URL for you first). Use this when you don't already have a direct URL. This canNOT read Google Maps reviews - Google blocks automated access to the reviews tab - so don't use it for that.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The gym's name" },
      location: { type: "string", description: "City/region to disambiguate, e.g. 'Canggu, Bali' or 'Brooklyn, NY'" },
    },
    required: ["name", "location"],
  },
}

// Both web_search and fetch_url are resolved internally on every
// provider now, never handed back to the caller as a "finding" to
// dispatch - unlike record_price_finding etc., which only the caller
// knows how to act on (write to Postgres), these two are pure research
// steps with no side effect of their own.
const INTERCEPTED_TOOL_NAMES = new Set(["web_search", "fetch_url", "find_website_on_google_maps"])

async function runIntercepted(name, input) {
  if (name === "web_search") return searchDuckDuckGo(input.query)
  if (name === "fetch_url") return fetchUrl(input.url)
  if (name === "find_website_on_google_maps") return findWebsiteOnGoogleMaps(input.name, input.location)
  return null
}

// Anthropic's own tool defs double as the canonical shape everywhere in
// this app (see CHAT_TOOLS/EDIT_VERIFICATION_TOOLS in index.js) - a
// `type: "web_search_20250305"` entry means "the hosted search tool",
// anything else (including FETCH_URL_TOOL above) is already a plain
// {name, description, input_schema} function tool. Translating to
// Ollama's OpenAI-style function-calling shape, the hosted search tool
// becomes a REAL function tool backed by searchDuckDuckGo above - from
// the model's perspective it's just another tool it can call, the same
// way record_price_finding is.
function toOllamaTool(tool) {
  if (tool.type === "web_search_20250305") {
    return {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information. Returns up to 3 results, each with a title, url, and snippet.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    }
  }
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }
}

// Loops because fetch_url (and, on this path, web_search too - Anthropic's
// hosted search was the one thing that used to resolve without a loop,
// but fetch_url never hosted) needs a real round trip: call the model,
// run whichever intercepted tool it asked for ourselves, feed the result
// back, let it continue. Stops as soon as the model produces any NON-
// intercepted tool call (a real finding for the caller - record_price_finding
// etc. - takes priority and returns immediately, even if an intercepted
// call appeared in the very same turn, which models essentially never do
// anyway) or no tool call at all. Capped at 4 rounds.
async function runAnthropicTurn({ system, tools, messages }) {
  let convo = messages
  for (let round = 0; round < 4; round++) {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system,
      ...(tools.length ? { tools } : {}),
      messages: convo,
    })
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use")
    const otherUses = toolUseBlocks.filter((b) => !INTERCEPTED_TOOL_NAMES.has(b.name))
    const interceptedUses = toolUseBlocks.filter((b) => INTERCEPTED_TOOL_NAMES.has(b.name))

    if (otherUses.length > 0) return { text, toolUses: otherUses.map((b) => ({ name: b.name, input: b.input })) }
    if (interceptedUses.length === 0) return { text, toolUses: [] }

    const toolResults = []
    for (const toolUse of interceptedUses) {
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: await runIntercepted(toolUse.name, toolUse.input) })
    }
    convo = [...convo, { role: "assistant", content: response.content }, { role: "user", content: toolResults }]
  }
  return { text: "", toolUses: [] }
}

// Caught live: a research turn that also calls find_website_on_google_maps
// (launches a real Playwright/Chromium browser) sometimes made the VERY
// NEXT ollama.chat() call fail outright with a raw "fetch failed" -
// reproduced repeatedly, while ollama.chat() called on its own, with no
// browser involved, worked every time. This machine has 8GB RAM total;
// a ~2GB local model plus a Chromium instance briefly tearing down is
// real resource contention, not a bug in the request itself - a short
// pause and one retry is the honest fix for a transient local-resource
// squeeze, not a code path that was ever actually broken.
async function chatWithRetry(convo, ollamaTools) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await ollama.chat({ model: OLLAMA_MODEL, messages: convo, ...(ollamaTools.length ? { tools: ollamaTools } : {}) })
    } catch (e) {
      console.error(`Ollama chat call failed (attempt ${attempt}/2):`, e.message)
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

// Same shape as above, adapted to Ollama's chat/tool_calls API instead
// of Anthropic's tool_use content blocks.
async function runOllamaTurn({ system, tools, messages }) {
  const ollamaTools = tools.map(toOllamaTool)
  let convo = [{ role: "system", content: system }, ...messages]

  for (let round = 0; round < 4; round++) {
    const response = await chatWithRetry(convo, ollamaTools)
    const calls = response.message.tool_calls || []
    const otherCalls = calls.filter((c) => !INTERCEPTED_TOOL_NAMES.has(c.function.name))
    const interceptedCalls = calls.filter((c) => INTERCEPTED_TOOL_NAMES.has(c.function.name))

    if (calls.length === 0 || otherCalls.length > 0) {
      return { text: response.message.content || "", toolUses: otherCalls.map((c) => ({ name: c.function.name, input: c.function.arguments })) }
    }

    convo = [...convo, { role: "assistant", content: response.message.content || "", tool_calls: calls }]
    for (const call of interceptedCalls) {
      const result = await runIntercepted(call.function.name, call.function.arguments)
      convo = [...convo, { role: "tool", content: JSON.stringify(result) }]
    }
  }
  return { text: "", toolUses: [] }
}

// The one function every call site in index.js uses instead of calling
// anthropic.messages.create directly - `tools` takes the SAME shape
// already used throughout this app (CHAT_TOOLS, EDIT_VERIFICATION_TOOLS),
// so switching AI_PROVIDER needs no changes at any call site.
export async function runAgentTurn({ system, tools = [], messages }) {
  return AI_PROVIDER === "ollama" ? runOllamaTurn({ system, tools, messages }) : runAnthropicTurn({ system, tools, messages })
}

export { AI_PROVIDER }
