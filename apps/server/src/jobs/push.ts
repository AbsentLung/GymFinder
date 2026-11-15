// Sends an Expo push notification when a request's status changes -
// goes through the queue like other slow work. Not live-verified
// against a real device (none available here).
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { requests, pushTokens } from "../db/schema.js"
import { queue } from "../queue/index.js"

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

export async function notifyRequestStatusChange(requestId: number): Promise<void> {
  await queue.add("push-notify", { requestId })
}

function buildMessage(request: typeof requests.$inferSelect): string | null {
  if (request.status === "failed") return "Your request timed out and couldn't be completed - you can retry it from My Requests."
  if (request.status !== "completed") return null

  if (request.kind === "sweep") {
    const result = request.result as { gymsFound: number; gymsNew: number } | null
    if (!result || result.gymsNew === 0) return "Sweep finished - no new gyms found in that area."
    return `Sweep finished - ${result.gymsNew} new gym${result.gymsNew === 1 ? "" : "s"} found!`
  }

  const result = request.result as { approved?: number; rejected?: number } | null
  const noun = request.kind === "add_gym" ? "new gym" : "gym update"
  if (result?.approved) return `Your ${noun} was approved.`
  if (result?.rejected) return `Your ${noun} wasn't approved.`
  return `Your ${noun} request was reviewed - check My Requests for details.`
}

export async function processPushNotify({ requestId }: { requestId: number }): Promise<void> {
  const [request] = await db.select().from(requests).where(eq(requests.id, requestId))
  if (!request || !request.userId) return // unlinked (account deleted) - no one to notify.

  const message = buildMessage(request)
  if (!message) return

  const tokens = await db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, request.userId))
  if (tokens.length === 0) return // no push registered - these users poll instead.

  await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(tokens.map((t) => ({ to: t.token, title: "GymFinder", body: message }))),
  })
}
