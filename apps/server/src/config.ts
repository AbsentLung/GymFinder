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
} as const

if (!config.databaseUrl) throw new Error("DATABASE_URL is not set")
if (MODE === "scale" && !config.anthropicApiKey) {
  throw new Error("ANTHROPIC_API_KEY is required in scale mode (LLM interface uses Claude)")
}
