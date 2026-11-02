// Worker entry point - picks up jobs the API enqueued. registerWorkerJobs
// is exported so src/dev.ts can register the same processors in demo
// mode's combined process; this file's own main() is the scale-mode
// standalone worker.
import { queue } from "./queue/index.js"
import { refreshTile } from "./jobs/tile-refresh.js"
import { processBotReviewChange } from "./jobs/bot-review-worker.js"
import { processChat } from "./jobs/chat.js"
import { processSweep } from "./jobs/sweep.js"
import { runWatchdog } from "./jobs/watchdog.js"

export async function registerWorkerJobs(): Promise<void> {
  await queue.process<{ geohash5: string }>("tile-refresh", async (payload) => {
    await refreshTile(payload)
  })
  await queue.process<{ changeId: number }>("bot-review", processBotReviewChange)
  await queue.process<Parameters<typeof processChat>[0]>("chat", processChat)
  await queue.process<{ requestId: number; geohash5: string }>("sweep", processSweep)
  await queue.process<Record<string, never>>("watchdog", async () => {
    await runWatchdog()
  })
  // Every minute - deadlines are ~10 minutes (API.md 2.4), so this never
  // leaves a genuinely stuck request waiting much past its own deadline.
  await queue.schedule("watchdog", "* * * * *")
  console.log("Worker processing: tile-refresh, bot-review, chat, sweep, watchdog")
}

async function main() {
  await queue.start()
  await registerWorkerJobs()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Worker failed to start:", e)
    process.exit(1)
  })
}
