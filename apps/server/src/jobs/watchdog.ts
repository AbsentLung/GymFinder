// API.md 2.4: "The watchdog marks overdue requests failed with
// failureReason: 'timed_out'." Two different "genuinely stuck" shapes,
// by kind:
//   - add_gym/update_gym: the BOT STEP ITSELF never finished (a
//     gym_changes row still stuck in pending_bot past the deadline - a
//     crashed/stuck worker job). A request that's correctly waiting on
//     an admin for an awaiting_admin change is NOT a timeout, no matter
//     how old - STACK_AND_SCHEMA.md 2.10 only calls a request "pending
//     until every change is decided," with no deadline on how long an
//     admin may take.
//   - sweep: there's no admin-wait equivalent at all - processSweep
//     (src/jobs/sweep.ts) always sets a terminal status itself before
//     returning, so ANY sweep still 'pending' past its own ~1 hour
//     deadline means the job crashed or was never picked up, full stop.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"

export async function runWatchdog(): Promise<void> {
  await db.execute(sql`
    UPDATE requests SET status = 'failed', failure_reason = 'timed_out'
    WHERE status = 'pending' AND deadline < now()
      AND (
        kind = 'sweep'
        OR EXISTS (SELECT 1 FROM gym_changes WHERE gym_changes.request_id = requests.id AND review_status = 'pending_bot')
      )
  `)
}
