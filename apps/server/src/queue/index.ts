// The one place that reads MODE for the queue (DESIGN_DISCUSSION.md
// 6.1) - every route/worker imports `queue` from here, never pg-boss or
// bullmq directly.
import { MODE, config } from "../config.js"
import { PgBossQueue } from "./pgboss-queue.js"
import { BullMqQueue } from "./bullmq-queue.js"
import type { QueueInterface } from "../interfaces/queue.js"

export const queue: QueueInterface = MODE === "scale" ? new BullMqQueue(config.redisUrl) : new PgBossQueue(config.databaseUrl)
