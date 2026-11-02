import { Redis } from "ioredis"
import type { CacheInterface } from "../interfaces/cache.js"

// Scale mode's CacheInterface. Not live-tested this session (no Redis
// running here) - ioredis's get/set/setex/del are standard enough that
// this is low-risk, but worth a real run before trusting it in
// production, same caveat as bullmq-queue.ts.
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
