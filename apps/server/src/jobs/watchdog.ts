// API.md 2.4: "The watchdog marks overdue requests failed with
// failureReason: 'timed_out'." Only fires when the BOT STEP ITSELF never
// finished (a gym_changes row still stuck in pending_bot past the
// request's deadline - a crashed/stuck worker job) - a request that's
// correctly waiting on an admin for an awaiting_admin change is not a
// timeout, no matter how old, since STACK_AND_SCHEMA.md 2.10 only calls
// a request "pending until every change is decided," with no deadline
// on how long an admin may take.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"

export async function runWatchdog(): Promise<void> {
  await db.execute(sql`
    UPDATE requests SET status = 'failed', failure_reason = 'timed_out'
    WHERE status = 'pending' AND deadline < now()
      AND EXISTS (SELECT 1 FROM gym_changes WHERE gym_changes.request_id = requests.id AND review_status = 'pending_bot')
  `)
}
