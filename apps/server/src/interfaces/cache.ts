// DESIGN_DISCUSSION.md 5.2: tiles, gym details, LLM/chat answers, and
// rate-limit counters all go through this - in-memory per process in
// demo mode, Redis in scale mode. Values are always strings (JSON
// serialized by the caller) since that's the common surface both a
// plain Map and Redis share.
export interface CacheInterface {
  get(key: string): Promise<string | null>
  /** `ttlSeconds` omitted means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
}
