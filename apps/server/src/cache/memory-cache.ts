import type { CacheInterface } from "../interfaces/cache.js"

// Demo mode's CacheInterface - "the cache falls back to in-memory"
// (DESIGN_DISCUSSION.md 6.1). Per-process only: fine for a single demo
// VM running API+worker in one process: multiple API copies in scale
// mode is exactly why that mode switches to Redis instead.
export class MemoryCache implements CacheInterface {
  private store = new Map<string, { value: string; expiresAt: number | null }>()

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    })
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }
}
