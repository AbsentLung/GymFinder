// Marks overdue requests "timed_out". add_gym/update_gym: only when the
// bot step itself never finished (admin-wait is never a timeout,
// however old). sweep: always sets a terminal status itself, so
// 'pending' past its deadline means the job crashed outright.
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { notifyRequestStatusChange } from "./push.js"

export async function runWatchdog(): Promise<void> {
  const result = await db.execute<{ id: number }>(sql`
    UPDATE requests SET status = 'failed', failure_reason = 'timed_out'
    WHERE status = 'pending' AND deadline < now()
      AND (
        kind = 'sweep'
        OR EXISTS (SELECT 1 FROM gym_changes WHERE gym_changes.request_id = requests.id AND review_status = 'pending_bot')
      )
    RETURNING id
  `)
  for (const row of result.rows) await notifyRequestStatusChange(row.id)
}
