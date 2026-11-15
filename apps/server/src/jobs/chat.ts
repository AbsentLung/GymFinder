// Two separate LLM turns - combining "find and record" with "answer"
// let the model state a found price without calling the tool. A found
// fact goes through bot-review first, so it's mentioned as unverified.
import { sql, eq, desc } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymPrices, reviews } from "../db/schema.js"
import { cache } from "../cache/index.js"
import { llm } from "../llm/index.js"
import { WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL } from "../llm/tools.js"
import { tryReverseGeocode } from "../geocode.js"
import { createGymChange, NON_PRICE_FIELDS } from "./bot-review.js"
import type { ProposedChange, PriceKind, NonPriceField } from "./bot-review.js"
import { amountMajorToMinor, GYM_CATEGORIES } from "../lib.js"
import type { ToolDef, ChatMessage } from "../interfaces/llm.js"

export const CHAT_TTL_SECONDS = 15 * 60

// question/history live only in the cache (chat:<chatId>:input), never
// in the job payload - CLAUDE.md forbids storing chat content in
// Postgres or logs, which a job payload would.
export interface ChatPayload {
  [key: string]: unknown
  chatId: string
  gymId: number
}

interface ChatInput {
  question: string
  history: ChatMessage[]
}

interface GymChatRow {
  [key: string]: unknown
  name: string
  lat: number
  lng: number
  description: string | null
  address: string | null
  categories: string[]
}

async function fetchGymForChat(gymId: number): Promise<GymChatRow | null> {
  const result = await db.execute<GymChatRow>(sql`
    SELECT name, ST_Y(location) AS lat, ST_X(location) AS lng, description, address, categories
    FROM gyms WHERE id = ${gymId}
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

async function setChatResult(chatId: string, result: Record<string, unknown>) {
  await cache.set(`chat:${chatId}`, JSON.stringify(result), CHAT_TTL_SECONDS)
}

export async function processChat({ chatId, gymId }: ChatPayload): Promise<void> {
  try {
    const rawInput = await cache.get(`chat:${chatId}:input`)
    if (!rawInput) {
      // TTL beat us to it, or something re-processed this chatId -
      // either way there's no question left to answer.
      await setChatResult(chatId, { status: "failed" })
      return
    }
    const { question, history }: ChatInput = JSON.parse(rawInput)
    await cache.del(`chat:${chatId}:input`)

    const gym = await fetchGymForChat(gymId)
    if (!gym) {
      await setChatResult(chatId, { status: "failed" })
      return
    }
    const location = await tryReverseGeocode(gym.lat, gym.lng)

    const researchPrompt = `A traveler is asking a question about the gym "${gym.name}"${
      location ? ` in ${location}` : ""
    }. Try to find out whatever you can that isn't already known about it, and call the matching record tool for ANYTHING credible you find - record_price for a specific day/week/month pass price, record_gym_field for its description, address, categories, drop-in availability, or trial availability. Always include the gym's location in your search query, not just its name - gym names like this are rarely unique worldwide. Start with web_search; a result's own snippet is a short marketing excerpt that often won't show the actual number you need, so use fetch_url on a promising result's real URL, or find_website_on_google_maps if you don't have a URL yet. This turn has no reply to write - if you find something worth stating, calling the tool for it IS the task. Don't force it if nothing comes up quickly; a couple of searches and moving on is fine.`

    const research = await llm.runAgentTurn({
      system: researchPrompt,
      tools: [WEB_SEARCH_TOOL, FETCH_URL_TOOL, GOOGLE_MAPS_WEBSITE_TOOL, RECORD_PRICE_TOOL, RECORD_FIELD_TOOL],
      messages: [{ role: "user", content: question }],
    })

    const sources: string[] = []
    for (const use of research.toolUses) {
      if (use.name === "record_price") {
        const input = use.input as { priceKind: PriceKind; amount: number; currency: string; sourceUrl?: string }
        const proposed: ProposedChange = {
          kind: "price",
          priceKind: input.priceKind,
          amountMinor: amountMajorToMinor(input.amount, input.currency),
          currency: input.currency,
          sourceKind: "chat",
          sourceUrl: input.sourceUrl ?? null,
          justification: "Found by the chat assistant while answering a traveler's question.",
        }
        await createGymChange(null, gymId, proposed)
        if (input.sourceUrl) sources.push(input.sourceUrl)
      } else if (use.name === "record_gym_field") {
        const input = use.input as { field: NonPriceField; value: unknown }
        const proposed: ProposedChange = {
          kind: "field",
          field: input.field,
          newValue: input.value,
          justification: "Found by the chat assistant while answering a traveler's question.",
        }
        await createGymChange(null, gymId, proposed)
      }
    }

    const prices = await db.select().from(gymPrices).where(eq(gymPrices.gymId, gymId))
    const recentReviews = await db
      .select({ rating: reviews.rating, body: reviews.body })
      .from(reviews)
      .where(eq(reviews.gymId, gymId))
      .orderBy(desc(reviews.createdAt))
      .limit(5)

    const formatPrice = (p: (typeof prices)[number]) =>
      `${p.kind}: ${p.amountMinor} ${p.currency}${p.verifiedBy ? "" : " (unverified)"}`

    const facts = `Gym name: ${gym.name}
Location: ${location ?? `coordinates ${gym.lat}, ${gym.lng}`}
Description: ${gym.description ?? "not known"}
Address: ${gym.address ?? "not known"}
Categories: ${gym.categories.length > 0 ? gym.categories.join(", ") : "not known"}
Prices on file: ${prices.length > 0 ? prices.map(formatPrice).join("; ") : "none on file"}
Reviews on file:
${recentReviews.map((r) => `- (${r.rating}★): ${r.body}`).join("\n") || "none yet"}`

    const researchNotes = research.text
      ? `\n\nResearch notes from this turn (NOT yet verified - mention only with appropriate caution, never as a confirmed fact):\n${research.text}`
      : ""

    const systemPrompt = `You are a helpful assistant answering a traveler's question about one specific gym, "${gym.name}". Answer using the facts below; anything in the research notes is unverified and must be flagged as such if you mention it. If something isn't covered by either, say you don't know rather than guessing. Keep answers short and conversational.\n\n${facts}${researchNotes}`

    const answer = await llm.ask({
      system: systemPrompt,
      messages: [...history, { role: "user", content: question }],
    })

    await setChatResult(chatId, { status: "answered", answer, sources })
  } catch (e) {
    console.error(`Chat ${chatId} failed:`, (e as Error).message)
    await setChatResult(chatId, { status: "failed" })
  }
}
