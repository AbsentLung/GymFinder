// Business code only imports `queue` from src/queue/index.ts, never
// pg-boss or bullmq directly - keeps it mode-agnostic. Named priority
// levels, not a raw number - the two backends order priority oppositely.
export type JobPriority = "low" | "normal" | "high"

export interface JobOptions {
  priority?: JobPriority
  /** Delay before the job becomes eligible to run, in milliseconds. */
  delay?: number
  /** Dedup key - adding a job with a jobId already active/queued is a no-op. No ":" (BullMQ rejects it). */
  jobId?: string
  /** Extra attempts after a failure, with exponential backoff. Omitted = the backend's default. */
  retries?: number
  /** First backoff delay in milliseconds; doubles per retry. */
  retryDelayMs?: number
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
