import { Redis } from "ioredis"
import type { CacheInterface } from "../interfaces/cache.js"

// Scale mode's CacheInterface. Not live-tested (no Redis running here).
export class RedisCache implements CacheInterface {
  private client: Redis

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl)
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds)
    else await this.client.set(key, value)
  }

  async del(key: string): Promise<void> {
    await this.client.del(key)
  }
}
