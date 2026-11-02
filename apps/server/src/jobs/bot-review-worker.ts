// Queue job handler for "bot-review" (enqueued by src/routes/requests.ts
// right after a request/gym_changes row is created - "anything that
// goes through a queue... can't answer in the same request", API.md
// 1.3). Runs every gym_changes row still pending_bot for one request
// through verifyGymChange and records the outcome.
import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { gymChanges } from "../db/schema.js"
import { verifyGymChange, applyDecision, recomputeRequestStatus } from "./bot-review.js"

export async function processBotReview({ requestId }: { requestId: number }): Promise<void> {
  const pending = await db
    .select()
    .from(gymChanges)
    .where(and(eq(gymChanges.requestId, requestId), eq(gymChanges.reviewStatus, "pending_bot")))

  for (const change of pending) {
    const result = await verifyGymChange(change.proposed as Parameters<typeof verifyGymChange>[0], change.gymId)

    if (result.reviewStatus === "awaiting_admin") {
      await db.update(gymChanges).set({ reviewStatus: "awaiting_admin", evidence: result.evidence }).where(eq(gymChanges.id, change.id))
    } else {
      await applyDecision(change.id, { reviewStatus: result.reviewStatus, decidedBy: result.decidedBy ?? "bot", evidence: result.evidence })
    }
  }

  await recomputeRequestStatus(requestId)
}
