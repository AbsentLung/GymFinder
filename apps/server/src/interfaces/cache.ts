// In-memory per process in demo mode, Redis in scale mode. Values are
// always strings - the common surface both a Map and Redis share.
export interface CacheInterface {
  get(key: string): Promise<string | null>
  /** `ttlSeconds` omitted means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
}
