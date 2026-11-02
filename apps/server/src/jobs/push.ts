// API.md 2.7: "When a request's status changes, the worker sends an
// Expo push notification to the user's tokens... Pushes go through the
// queue like other slow work." Expo's push API needs no API key for a
// basic send (https://docs.expo.dev/push-notifications/sending-notifications/)
// - just a valid Expo push token per recipient.
//
// Not live-verified against a real device/Expo push token this
// session (none available in this environment) - the HTTP call itself
// is built exactly to Expo's documented request shape, but delivery
// hasn't been confirmed end-to-end the way every other job in this
// module has been. Flagged rather than silently assumed working.
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
  if (tokens.length === 0) return // signed-out/no-push-registered users poll instead (API.md 2.7).

  await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(tokens.map((t) => ({ to: t.token, title: "GymFinder", body: message }))),
  })
}
