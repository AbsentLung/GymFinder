// Marks overdue requests "timed_out" - only when the bot step itself
// never finished (a gym_changes row stuck in pending_bot). A request
// correctly waiting on an admin is never a timeout, however old.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"

export async function runWatchdog(): Promise<void> {
  await db.execute(sql`
    UPDATE requests SET status = 'failed', failure_reason = 'timed_out'
    WHERE status = 'pending' AND deadline < now()
      AND EXISTS (SELECT 1 FROM gym_changes WHERE gym_changes.request_id = requests.id AND review_status = 'pending_bot')
  `)
}
