// STACK_AND_SCHEMA.md 1.2: "The interface only exposes what both
// support: add(queue, payload, {priority, delay, jobId}),
// process(queue, handler, {concurrency}), schedule(cron)." Business
// code (routes, workers) only ever imports `queue` from
// src/queue/index.ts, never pg-boss or bullmq directly - that's what
// keeps it mode-agnostic (DESIGN_DISCUSSION.md 6.1).
// Named levels, not a raw number - caught before anything actually used
// this field (the seed CLI, scripts/seed.ts, is the first caller):
// pg-boss's own priority is "higher number processed first," while
// BullMQ's is the OPPOSITE ("lower number processed first," and - more
// surprising - an unset priority is treated as MORE urgent than any
// explicitly prioritized job, not neutral). A single numeric value
// passed straight through would silently mean opposite things in demo
// vs scale mode. Each implementation maps these three levels to its own
// correct numbers internally (src/queue/pgboss-queue.ts,
// src/queue/bullmq-queue.ts).
export type JobPriority = "low" | "normal" | "high"

export interface JobOptions {
  priority?: JobPriority
  /** Delay before the job becomes eligible to run, in milliseconds. */
  delay?: number
  /**
   * Dedup key ("merge duplicate jobs (same tile)", DESIGN_DISCUSSION.md
   * 5.3) - adding a job with a jobId that's already active/queued is a
   * no-op rather than a second job. Maps to pg-boss's `singletonKey` in
   * demo mode and BullMQ's own `jobId` in scale mode.
   */
  jobId?: string
}

export type JobHandler<T = Record<string, unknown>> = (payload: T) => Promise<void>

export interface QueueInterface {
  start(): Promise<void>
  stop(): Promise<void>
  add<T extends Record<string, unknown>>(queueName: string, payload: T, opts?: JobOptions): Promise<{ id: string | null }>
  process<T extends Record<string, unknown>>(
    queueName: string,
    handler: JobHandler<T>,
    opts?: { concurrency?: number }
  ): Promise<void>
  schedule(queueName: string, cron: string, payload?: Record<string, unknown>): Promise<void>
}
