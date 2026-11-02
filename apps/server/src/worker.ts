// Worker entry point - picks up jobs the API enqueued (DESIGN_DISCUSSION.md
// Option B). In demo mode this can run in the same process as the API
// (see package.json's "dev" script); scale mode deploys it separately,
// auto-scaled on queue depth.
import { queue } from "./queue/index.js"
import { refreshTile } from "./jobs/tile-refresh.js"

async function main() {
  await queue.start()
  await queue.process<{ geohash5: string }>("tile-refresh", async (payload) => {
    await refreshTile(payload)
  })
  console.log("Worker started, processing: tile-refresh")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Worker failed to start:", e)
    process.exit(1)
  })
}
