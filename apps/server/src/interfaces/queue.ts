// Business code only imports `queue` from src/queue/index.ts, never
// pg-boss or bullmq directly - keeps it mode-agnostic.
//
// Named levels, not a raw number - pg-boss and BullMQ order priority in
// OPPOSITE directions. Each implementation maps these to its own
// correct numbers internally.
export type JobPriority = "low" | "normal" | "high"

export interface JobOptions {
  priority?: JobPriority
  /** Delay before the job becomes eligible to run, in milliseconds. */
  delay?: number
  /** Dedup key - adding a job with a jobId already active/queued is a no-op. */
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
