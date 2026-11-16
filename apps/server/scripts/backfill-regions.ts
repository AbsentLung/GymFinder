// Enqueues the region backfill for gyms with no region_id yet (LOCATION_NAMES.md).
// A running worker does the work; re-run after loading more boundaries.
//
// Usage: DATABASE_URL=... npm run backfill:regions
import { pool } from "../src/db/index.js"
import { queue } from "../src/queue/index.js"
import { REGION_BACKFILL_QUEUE } from "../src/jobs/gym-region.js"

async function main() {
  await queue.start()
  // A per-run jobId, so a finished earlier backfill never blocks a new one.
  await queue.add(REGION_BACKFILL_QUEUE, { afterId: 0 }, { jobId: `region-backfill-start-${Date.now()}`, priority: "low" })
  console.log("Region backfill enqueued; a worker will fill gyms.region_id in batches.")
  await queue.stop()
}

main()
  .catch((e) => {
    console.error("backfill:regions failed:", e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
