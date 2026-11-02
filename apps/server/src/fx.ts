// Same free, no-key rate source as the old demo (server/index.js's
// getFxRates), but backed by the `fx_rates` table instead of an
// in-memory cache - API.md 2.8 ("workers store usdCents... using a
// daily rates table") needs this shared across however many worker
// processes are running, not refetched independently by each one the
// way a per-process in-memory cache would.
import { eq } from "drizzle-orm"
import { db } from "./db/index.js"
import { fxRates } from "./db/schema.js"

const CACHE_MS = 24 * 60 * 60 * 1000

export async function getFxRates(): Promise<Record<string, number>> {
  const [row] = await db.select().from(fxRates).where(eq(fxRates.id, "latest"))
  if (row && Date.now() - new Date(row.fetchedAt).getTime() < CACHE_MS) {
    return row.rates as Record<string, number>
  }

  const res = await fetch("https://open.er-api.com/v6/latest/USD")
  const data = await res.json()
  if (data.result !== "success") throw new Error("FX rate fetch failed")

  await db
    .insert(fxRates)
    .values({ id: "latest", rates: data.rates, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: fxRates.id, set: { rates: data.rates, fetchedAt: new Date() } })

  return data.rates as Record<string, number>
}
