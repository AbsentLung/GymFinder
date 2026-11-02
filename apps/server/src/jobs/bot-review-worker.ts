// Queue job handler for "bot-review" - one job per gym_changes row.
// Per-change, not per-request: a chat-found fact has no request at all.
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges } from "../db/schema.js"
import { verifyGymChange, applyDecision, recomputeRequestStatus } from "./bot-review.js"
import type { ProposedChange } from "./bot-review.js"

export async function processBotReviewChange({ changeId }: { changeId: number }): Promise<void> {
  const [change] = await db.select().from(gymChanges).where(eq(gymChanges.id, changeId))
  // Already decided (e.g. an admin got to it first) - nothing to do.
  if (!change || change.reviewStatus !== "pending_bot") return

  const result = await verifyGymChange(change.proposed as ProposedChange, change.gymId)

  if (result.reviewStatus === "awaiting_admin") {
    await db.update(gymChanges).set({ reviewStatus: "awaiting_admin", evidence: result.evidence }).where(eq(gymChanges.id, changeId))
    // Still open - applyDecision (the other branch) recomputes this
    // itself after a terminal decision; awaiting_admin needs the same
    // call here since nothing else will make it.
    if (change.requestId) await recomputeRequestStatus(change.requestId)
  } else {
    await applyDecision(changeId, { reviewStatus: result.reviewStatus, decidedBy: result.decidedBy ?? "bot", evidence: result.evidence })
  }
}
