// Worker entry point - picks up jobs the API enqueued (DESIGN_DISCUSSION.md
// Option B). In demo mode this can run in the same process as the API
// (see package.json's "dev" script); scale mode deploys it separately,
// auto-scaled on queue depth.
import { queue } from "./queue/index.js"
import { refreshTile } from "./jobs/tile-refresh.js"
import { processBotReview } from "./jobs/bot-review-worker.js"
import { runWatchdog } from "./jobs/watchdog.js"

async function main() {
  await queue.start()
  await queue.process<{ geohash5: string }>("tile-refresh", async (payload) => {
    await refreshTile(payload)
  })
  await queue.process<{ requestId: number }>("bot-review", processBotReview)
  await queue.process<Record<string, never>>("watchdog", async () => {
    await runWatchdog()
  })
  // Every minute - deadlines are ~10 minutes (API.md 2.4), so this never
  // leaves a genuinely stuck request waiting much past its own deadline.
  await queue.schedule("watchdog", "* * * * *")
  console.log("Worker started, processing: tile-refresh, bot-review, watchdog")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Worker failed to start:", e)
    process.exit(1)
  })
}
