// Scale mode's QueueInterface. Not live-tested in this session (no
// Redis running here) - confirmed against BullMQ's own shipped .d.ts
// files for the Queue/Worker constructor and JobsOptions shapes, same
// as the pg-boss side, but this one still needs a real Redis to
// exercise before trusting it in production.
import { Queue, Worker, type ConnectionOptions } from "bullmq"
import { Redis } from "ioredis"
import type { QueueInterface, JobOptions, JobHandler, JobPriority } from "../interfaces/queue.js"

// BullMQ's own priority is "lower number runs first" - the OPPOSITE of
// pg-boss's "higher number runs first" (src/queue/pgboss-queue.ts).
// Every level gets an explicit number, including "normal": BullMQ also
// treats a job with NO priority set as more urgent than any explicitly
// prioritized job (confirmed against its own JobsOptions doc comment,
// not assumed) - leaving "normal" unset would put it ahead of "high"
// instead of between "high" and "low".
const PRIORITY_RANK: Record<JobPriority, number> = { high: 1, normal: 50, low: 100 }

export class BullMqQueue implements QueueInterface {
  private connection: ConnectionOptions
  private queues = new Map<string, Queue>()
  private workers: Worker[] = []

  constructor(redisUrl: string) {
    // BullMQ's blocking commands require this - a finite retry count
    // makes ioredis give up and throw instead of blocking forever.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null })
  }

  async start() {
    // BullMQ queues/workers connect lazily on first use - nothing to do
    // eagerly here, unlike pg-boss's explicit start().
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.close()))
    await Promise.all([...this.queues.values()].map((q) => q.close()))
  }

  private getQueue(name: string): Queue {
    let q = this.queues.get(name)
    if (!q) {
      q = new Queue(name, { connection: this.connection })
      this.queues.set(name, q)
    }
    return q
  }

  async add<T extends Record<string, unknown>>(queueName: string, payload: T, opts: JobOptions = {}) {
    const job = await this.getQueue(queueName).add(queueName, payload, {
      priority: opts.priority !== undefined ? PRIORITY_RANK[opts.priority] : undefined,
      delay: opts.delay,
      jobId: opts.jobId,
    })
    return { id: job.id ?? null }
  }

  async process<T extends Record<string, unknown>>(
    queueName: string,
    handler: JobHandler<T>,
    opts: { concurrency?: number } = {}
  ) {
    const worker = new Worker<T>(
      queueName,
      async (job) => {
        await handler(job.data)
      },
      { connection: this.connection, concurrency: opts.concurrency ?? 1 }
    )
    this.workers.push(worker)
  }

  async schedule(queueName: string, cron: string, payload: Record<string, unknown> = {}) {
    await this.getQueue(queueName).upsertJobScheduler(`${queueName}-cron`, { pattern: cron }, { data: payload })
  }
}
