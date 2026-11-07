// Enqueues the area backfill for gyms with no area_id yet (LOCATION_NAMES.md).
// A running worker does the work; re-run after loading more boundaries.
//
// Usage: DATABASE_URL=... npm run backfill:areas
import { pool } from "../src/db/index.js"
import { queue } from "../src/queue/index.js"
import { AREA_BACKFILL_QUEUE } from "../src/jobs/gym-area.js"

async function main() {
  await queue.start()
  // A per-run jobId, so a finished earlier backfill never blocks a new one.
  await queue.add(AREA_BACKFILL_QUEUE, { afterId: 0 }, { jobId: `area-backfill-start-${Date.now()}`, priority: "low" })
  console.log("Area backfill enqueued; a worker will fill gyms.area_id in batches.")
  await queue.stop()
}

main()
  .catch((e) => {
    console.error("backfill:areas failed:", e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
