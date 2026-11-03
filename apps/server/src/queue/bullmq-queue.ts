// Scale mode's QueueInterface. Not live-tested (no Redis running here)
// - confirmed against BullMQ's own .d.ts files, but still needs a real
// Redis run before trusting it in production.
import { Queue, Worker, type ConnectionOptions } from "bullmq"
import { Redis } from "ioredis"
import type { QueueInterface, JobOptions, JobHandler } from "../interfaces/queue.js"

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
      priority: opts.priority,
      delay: opts.delay,
      jobId: opts.jobId,
      // BullMQ keeps a finished job's id by default - without this, a
      // cell's custom id stays "already exists" forever after one run.
      removeOnComplete: true,
      removeOnFail: true,
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
