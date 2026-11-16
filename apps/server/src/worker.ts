// Worker entry point - registerWorkerJobs is exported so dev.ts can
// reuse it in demo mode's combined process; main() below is scale-only.
import { queue } from "./queue/index.js"
import { refreshTile } from "./jobs/tile-refresh.js"
import { processBotReviewChange } from "./jobs/bot-review-worker.js"
import { processChat } from "./jobs/chat.js"
import { processSweep } from "./jobs/sweep.js"
import { processResearchGym } from "./jobs/research-gym.js"
import type { ResearchGymPayload } from "./jobs/research-gym.js"
import { processPushNotify } from "./jobs/push.js"
import { runWatchdog } from "./jobs/watchdog.js"
import {
  REGION_BACKFILL_QUEUE,
  GYM_REGION_PHOTON_QUEUE,
  GYM_REGION_QUEUE,
  processRegionBackfill,
  processGymRegion,
  processGymRegionPhoton,
} from "./jobs/gym-region.js"

export async function registerWorkerJobs(): Promise<void> {
  // Default concurrency is 1 - one stale geohash4 tile can enqueue up
  // to 32 cells. 2 is overpass-api.de's own stated concurrency limit.
  await queue.process<{ geohash5: string }>(
    "tile-refresh",
    async (payload) => {
      await refreshTile(payload)
    },
    { concurrency: 2 }
  )
  await queue.process<{ changeId: number }>("bot-review", processBotReviewChange)
  await queue.process<Parameters<typeof processChat>[0]>("chat", processChat)
  await queue.process<{ requestId: number; geohash5: string }>("sweep", processSweep)
  await queue.process<ResearchGymPayload>("research-gym", processResearchGym)
  await queue.process<{ requestId: number }>("push-notify", processPushNotify)
  await queue.process<{ gymId: number }>(GYM_REGION_QUEUE, processGymRegion, { concurrency: 4 })
  // One at a time per worker; the shared limiter keeps Photon at ~1 req/s overall.
  await queue.process<{ gymId: number }>(GYM_REGION_PHOTON_QUEUE, processGymRegionPhoton)
  await queue.process<{ afterId: number }>(REGION_BACKFILL_QUEUE, processRegionBackfill)
  await queue.process<Record<string, never>>("watchdog", async () => {
    await runWatchdog()
  })
  // Every minute - deadlines are ~10 minutes (API.md 2.4), so this never
  // leaves a genuinely stuck request waiting much past its own deadline.
  await queue.schedule("watchdog", "* * * * *")
  console.log(
    "Worker processing: tile-refresh, bot-review, chat, sweep, research-gym, push-notify, gym-region, gym-region-photon, region-backfill, watchdog"
  )
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
