import { MODE, config } from "../config.js"
import { MemoryCache } from "./memory-cache.js"
import { RedisCache } from "./redis-cache.js"
import type { CacheInterface } from "../interfaces/cache.js"

export const cache: CacheInterface = MODE === "scale" ? new RedisCache(config.redisUrl) : new MemoryCache()
