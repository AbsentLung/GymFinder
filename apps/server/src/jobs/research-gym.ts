// Background enrichment for a sweep-found gym - same research-and-
// record pattern as chat.ts's record_price/record_gym_field, just
// triggered right after a new gym appears instead of a question.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { llm } from "../llm/index.js"
import { WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL } from "../llm/tools.js"
import { tryReverseGeocode } from "../geocode.js"
import { createGymChange, normalizeFieldValue, NON_PRICE_FIELDS } from "./bot-review.js"
import type { ProposedChange, PriceKind, NonPriceField } from "./bot-review.js"
import { amountMajorToMinor, GYM_CATEGORIES } from "../lib.js"
import type { ToolDef } from "../interfaces/llm.js"

export interface ResearchGymPayload {
  [key: string]: unknown
  gymId: number
}

interface GymRow {
  [key: string]: unknown
  name: string
  lat: number
  lng: number
}

async function fetchGymForResearch(gymId: number): Promise<GymRow | null> {
  const result = await db.execute<GymRow>(sql`
    SELECT name, ST_Y(location) AS lat, ST_X(location) AS lng FROM gyms WHERE id = ${gymId}
  `)
  return result.rows[0] ?? null
}

const RECORD_PRICE_TOOL: ToolDef = {
  name: "record_price",
  description:
    "Record a day/week/month pass price you found via research, for review before it's shown as confirmed on the gym's page. Report the amount in its ORIGINAL currency - don't convert it yourself.",
  inputSchema: {
    type: "object",
    properties: {
      priceKind: { type: "string", enum: ["day_pass", "week_pass", "month_pass"] },
      amount: { type: "number", description: "The price in its own currency's normal units, e.g. 15 for $15, or 375000 for Rp375,000." },
      currency: { type: "string", description: "ISO 4217 code, e.g. USD, IDR." },
      sourceUrl: { type: "string" },
    },
    required: ["priceKind", "amount", "currency"],
  },
}

const RECORD_FIELD_TOOL: ToolDef = {
  name: "record_gym_field",
  description: `Record this gym's description, address, which of the fixed categories apply (${GYM_CATEGORIES.join(", ")}), whether it accepts drop-ins, or whether it offers a trial - whichever you found via research, for review before it's shown as confirmed.`,
  inputSchema: {
    type: "object",
    properties: {
      field: { type: "string", enum: NON_PRICE_FIELDS },
      value: {},
    },
    required: ["field", "value"],
  },
}

export async function processResearchGym({ gymId }: ResearchGymPayload): Promise<void> {
  const gym = await fetchGymForResearch(gymId)
  if (!gym) return
  const location = await tryReverseGeocode(gym.lat, gym.lng)

  const researchPrompt = `A gym called "${gym.name}"${
    location ? ` in ${location}` : ""
  } was just found via a Google Maps sweep - only its name and location are known so far. Try to find its description, address, categories, drop-in/trial availability, and day/week/month pass prices, and call the matching record tool for anything credible you find. Always include the location in your search query, not just the name. Start with web_search or find_website_on_google_maps; use fetch_url on a promising URL. Don't force it if nothing comes up quickly - a couple of searches and moving on is fine.`

  const research = await llm.runAgentTurn({
    system: researchPrompt,
    tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL, RECORD_PRICE_TOOL, RECORD_FIELD_TOOL],
    messages: [{ role: "user", content: "Research this gym." }],
  })

  for (const use of research.toolUses) {
    if (use.name === "record_price") {
      const input = use.input as { priceKind: PriceKind; amount: number; currency: string; sourceUrl?: string }
      const proposed: ProposedChange = {
        kind: "price",
        priceKind: input.priceKind,
        amountMinor: amountMajorToMinor(input.amount, input.currency),
        currency: input.currency,
        sourceKind: "sweep_research",
        sourceUrl: input.sourceUrl ?? null,
        justification: "Found by background research after a Google Maps sweep.",
      }
      await createGymChange(null, gymId, proposed)
    } else if (use.name === "record_gym_field") {
      const input = use.input as { field: NonPriceField; value: unknown }
      const value = normalizeFieldValue(input.field, input.value)
      if (value === null) continue
      const proposed: ProposedChange = {
        kind: "field",
        field: input.field,
        newValue: value,
        justification: "Found by background research after a Google Maps sweep.",
      }
      await createGymChange(null, gymId, proposed)
    }
  }
}
