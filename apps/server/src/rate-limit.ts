// Small, cache-backed fixed-window limiter. Not atomic - a read-then-
// write race could let a couple extra requests through, a fine
// tradeoff for a counter, not a payments system.
import { cache } from "./cache/index.js"

export async function checkRateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const raw = await cache.get(`ratelimit:${key}`)
  const count = raw ? Number(raw) : 0
  if (count >= max) return false
  await cache.set(`ratelimit:${key}`, String(count + 1), windowSeconds)
  return true
}
