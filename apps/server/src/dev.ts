// Demo mode's combined API+worker process. Needed for real, not just an
// optimization: the in-memory cache is per-process, and chat writes its
// answer from the worker side while the API reads it back - that only
// works if both are the same process.
import { config, MODE } from "./config.js"
import { queue } from "./queue/index.js"
import { buildApp } from "./api.js"
import { registerWorkerJobs } from "./worker.js"

async function main() {
  if (MODE !== "demo") {
    throw new Error("src/dev.ts is the demo-mode combined process - in scale mode, run `npm run start` and `npm run worker` as separate deployments instead.")
  }
  await queue.start()
  await registerWorkerJobs()
  const app = await buildApp()
  await app.listen({ port: config.port, host: "0.0.0.0" })
}

main().catch((e) => {
  console.error("Dev process failed to start:", e)
  process.exit(1)
})
