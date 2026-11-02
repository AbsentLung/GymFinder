// Demo mode's QueueInterface, confirmed against pg-boss's own shipped
// .d.ts files (node_modules/pg-boss/dist/types.d.ts), not memory - the
// README's example code is older-style than the actual current API
// surface, so the real signatures came from there.
import { PgBoss } from "pg-boss"
import type { Job } from "pg-boss"
import type { QueueInterface, JobOptions, JobHandler } from "../interfaces/queue.js"

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

  // `exclusive` policy is what actually makes singletonKey dedupe
  // anything - caught live: pg-boss's default queue policy ('standard')
  // accepts a singletonKey argument without error but doesn't enforce
  // any uniqueness on it at all, so two `add()` calls with the same
  // jobId silently queued two separate jobs instead of merging. Only
  // safe to apply blindly because every caller of this queue always
  // supplies a jobId (confirmed: the one caller today, the tiles route,
  // always does) - `exclusive` also coalesces jobs with NO singletonKey
  // onto the same empty-string slot, which would wrongly serialize an
  // all-jobId-less queue to one job at a time. A future queue that mixes
  // jobId and non-jobId sends would need its own non-exclusive queue.
  private async ensureQueue(name: string) {
    if (this.knownQueues.has(name)) return
    await this.boss.createQueue(name, { policy: "exclusive" })
    this.knownQueues.add(name)
  }

  async add<T extends Record<string, unknown>>(queueName: string, payload: T, opts: JobOptions = {}) {
    await this.ensureQueue(queueName)
    // pg-boss's own arg-checking rejects `priority: undefined` as "not
    // an integer" rather than treating it as unset (caught live) - keys
    // can only be included when they actually have a value.
    const id = await this.boss.send(queueName, payload, {
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.delay !== undefined ? { startAfter: new Date(Date.now() + opts.delay) } : {}),
      // pg-boss's dedup mechanism is `singletonKey`, not an `id` you
      // supply - this is where the interface's generic `jobId` name
      // (STACK_AND_SCHEMA.md 1.2's literal wording) maps to pg-boss's
      // own concept for it.
      ...(opts.jobId !== undefined ? { singletonKey: opts.jobId } : {}),
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
