// Demo mode's QueueInterface, confirmed against pg-boss's own .d.ts
// files - its README's example code is out of date with the real API.
import { PgBoss } from "pg-boss"
import type { Job } from "pg-boss"
import type { QueueInterface, JobOptions, JobHandler, JobPriority } from "../interfaces/queue.js"

// pg-boss orders by `priority DESC` (confirmed by reading
// pg-boss/dist/plans.js directly, same discipline as the exclusive-
// policy bug below) - higher number runs first.
const PRIORITY_RANK: Record<JobPriority, number> = { low: 1, normal: 5, high: 10 }

export class PgBossQueue implements QueueInterface {
  private boss: PgBoss
  private knownQueues = new Set<string>()

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString)
  }

  async start() {
    await this.boss.start()
  }

  async stop() {
    await this.boss.stop()
  }

  // `exclusive` is what makes singletonKey actually dedupe - pg-boss's
  // default `standard` policy accepts it but enforces no uniqueness.
  // But `exclusive` also serializes any queue with NO singletonKey to
  // one job at a time, silently dropping the rest. Opt queues in here
  // only once every `send` to them supplies a jobId.
  private static readonly SINGLETON_QUEUES = new Set(["tile-refresh", "bot-review", "sweep", "research-gym", "gym-region", "gym-region-photon", "region-backfill"])

  private async ensureQueue(name: string) {
    if (this.knownQueues.has(name)) return
    await this.boss.createQueue(name, PgBossQueue.SINGLETON_QUEUES.has(name) ? { policy: "exclusive" } : {})
    this.knownQueues.add(name)
  }

  async add<T extends Record<string, unknown>>(queueName: string, payload: T, opts: JobOptions = {}) {
    await this.ensureQueue(queueName)
    // pg-boss rejects `priority: undefined` as "not an integer" - keys
    // can only be included when they have a value.
    const id = await this.boss.send(queueName, payload, {
      ...(opts.priority !== undefined ? { priority: PRIORITY_RANK[opts.priority] } : {}),
      ...(opts.delay !== undefined ? { startAfter: new Date(Date.now() + opts.delay) } : {}),
      // pg-boss's dedup mechanism is `singletonKey`, not a supplied id.
      ...(opts.jobId !== undefined ? { singletonKey: opts.jobId } : {}),
      ...(opts.retries !== undefined ? { retryLimit: opts.retries, retryBackoff: true } : {}),
      // pg-boss counts retry delays in whole seconds.
      ...(opts.retryDelayMs !== undefined ? { retryDelay: Math.max(1, Math.ceil(opts.retryDelayMs / 1000)) } : {}),
    })
    return { id }
  }

  async process<T extends Record<string, unknown>>(
    queueName: string,
    handler: JobHandler<T>,
    opts: { concurrency?: number } = {}
  ) {
    await this.ensureQueue(queueName)
    await this.boss.work<T>(
      queueName,
      { localConcurrency: opts.concurrency ?? 1 },
      async (jobs: Job<T>[]) => {
        await handler(jobs[0].data)
      }
    )
  }

  async schedule(queueName: string, cron: string, payload: Record<string, unknown> = {}) {
    await this.ensureQueue(queueName)
    await this.boss.schedule(queueName, cron, payload)
  }
}
