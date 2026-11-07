// Same free rate source as the old demo, backed by the `fx_rates` table
// instead of an in-memory cache, so it's shared across worker processes.
import { eq } from "drizzle-orm"
import { db } from "./db/index.js"
import { fxRates } from "./db/schema.js"

const CACHE_MS = 24 * 60 * 60 * 1000

export async function getFxRates(): Promise<Record<string, number>> {
  const [row] = await db.select().from(fxRates).where(eq(fxRates.id, "latest"))
  if (row && Date.now() - new Date(row.fetchedAt).getTime() < CACHE_MS) {
    return row.rates as Record<string, number>
  }

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    if (data.result !== "success") throw new Error("FX rate fetch failed")

    await db
      .insert(fxRates)
      .values({ id: "latest", rates: data.rates, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: fxRates.id, set: { rates: data.rates, fetchedAt: new Date() } })

    return data.rates as Record<string, number>
  } catch (e) {
    // Every tile/gym-details read converts prices through this - an
    // outage after the cache expires would otherwise 500 every one of
    // them. A stale rate is still far better than no rate at all.
    if (row) return row.rates as Record<string, number>
    throw e
  }
}
