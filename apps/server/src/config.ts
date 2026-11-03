// Read once at startup - every factory reads this, never process.env.MODE
// directly, so there's exactly one place that branches on mode.
export type Mode = "demo" | "scale"

function readMode(): Mode {
  const raw = process.env.MODE
  if (raw === "scale") return "scale"
  if (raw === "demo" || raw === undefined) return "demo"
  throw new Error(`Invalid MODE "${raw}" - must be "demo" or "scale"`)
}

export const MODE: Mode = readMode()

export const config = {
  mode: MODE,
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Only read in scale mode (factories below), but validated here so a
  // missing value fails at startup, not on the first job/cache miss.
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  // Needed for correct callback/redirect URLs, not just a label.
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${Number(process.env.PORT ?? 3001)}`,
  // The web app's own origin - Better Auth validates a request's Origin
  // header against trustedOrigins (src/auth.ts) regardless of platform,
  // not just the native app's travelapp:// scheme. 8081 is Expo's own
  // default web dev port. In production this becomes the real
  // CloudFront/domain origin (Phase 7).
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:8081",
  // All optional - undefined in local dev (no real OAuth app yet).
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  facebookClientId: process.env.FACEBOOK_CLIENT_ID,
  facebookClientSecret: process.env.FACEBOOK_CLIENT_SECRET,
} as const

if (!config.databaseUrl) throw new Error("DATABASE_URL is not set")
if (MODE === "scale" && !config.anthropicApiKey) {
  throw new Error("ANTHROPIC_API_KEY is required in scale mode (LLM interface uses Claude)")
}
