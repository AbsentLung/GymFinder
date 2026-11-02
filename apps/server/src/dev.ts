// Demo mode's combined API+worker process (DESIGN_DISCUSSION.md section
// 6: "API + workers + queue can all run inside one process in demo
// mode" / "One small VM running API + workers in one process"). Needed
// for real, not just as an optimization: the cache interface's demo-mode
// implementation (src/cache/memory-cache.ts) is a plain in-process Map -
// chat (src/jobs/chat.ts) writes its answer to that cache from the
// worker side and the API reads it back from `GET /v1/chats/{chatId}`,
// which only works if both sides are the SAME process. Running
// `npm run start` and `npm run worker` as two separate demo-mode
// processes (as earlier Phase 5 slices did for local testing) works for
// everything backed by Postgres (the queue itself, tile-refresh,
// bot-review) but silently breaks chat specifically, since nothing
// about those other jobs ever crossed the API/worker boundary through
// the in-memory cache until now.
import { config, MODE } from "./config.js"
import { queue } from "./queue/index.js"
import { buildApp } from "./api.js"
import { registerWorkerJobs } from "./worker.js"

async function main() {
  if (MODE !== "demo") {
    throw new Error("src/dev.ts is the demo-mode combined process - in scale mode, run `npm run start` and `npm run worker` as separate deployments instead.")
  }
  await queue.start()
  await registerWorkerJobs()
  const app = await buildApp()
  await app.listen({ port: config.port, host: "0.0.0.0" })
}

main().catch((e) => {
  console.error("Dev process failed to start:", e)
  process.exit(1)
})
