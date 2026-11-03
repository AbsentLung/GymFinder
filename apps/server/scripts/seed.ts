// CLI seeding - reuses the same queue/workers/sources as a user sweep,
// both at low priority so a real request jumps ahead.
//
// Resumable by construction: each tile's staleness is read fresh before
// enqueueing, so a re-run only re-does tiles still stale.
//
// Usage:
//   DATABASE_URL=postgres://... npx tsx scripts/seed.ts --list destinations.json
import { readFileSync } from "node:fs"
import { and, eq, sql } from "drizzle-orm"
import { db } from "../src/db/index.js"
import { requests, tileFetches } from "../src/db/schema.js"
import { queue } from "../src/queue/index.js"
import { isFetchRowFresh, geohash5TilesCoveringBbox, type Bbox } from "../src/lib.js"

const STALE_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_DEADLINE_MS = 60 * 60 * 1000

interface Destination extends Bbox {
  name: string
}

async function isFresh(geohash: string, source: string): Promise<boolean> {
  const [row] = await db
    .select({ lastFetchedAt: tileFetches.lastFetchedAt, status: tileFetches.status })
    .from(tileFetches)
    .where(and(eq(tileFetches.geohash, geohash), eq(tileFetches.source, source)))
  return isFetchRowFresh(row, STALE_MS)
}

async function main() {
  const listArgIdx = process.argv.indexOf("--list")
  if (listArgIdx === -1 || !process.argv[listArgIdx + 1]) {
    console.error("Usage: npx tsx scripts/seed.ts --list destinations.json")
    process.exit(1)
  }
  const listPath = process.argv[listArgIdx + 1]
  const destinations: Destination[] = JSON.parse(readFileSync(listPath, "utf-8"))

  await queue.start()

  let tilesTouched = 0
  let tilesSkipped = 0

  for (const dest of destinations) {
    const tiles = geohash5TilesCoveringBbox(dest)
    console.log(`${dest.name}: ${tiles.length} geohash5 tiles`)

    for (const tile of tiles) {
      const osmFresh = await isFresh(tile, "osm")
      if (!osmFresh) {
        await queue.add("tile-refresh", { geohash5: tile }, { jobId: `tile-refresh-${tile}`, priority: "low" })
        tilesTouched++
      } else {
        tilesSkipped++
      }

      const googleMapsFresh = await isFresh(tile, "google_maps")
      if (!googleMapsFresh) {
        // A prior run's sweep for this tile might still be in-flight -
        // attach to it instead, same as POST /v1/sweeps itself.
        const [pending] = await db
          .select({ id: requests.id })
          .from(requests)
          .where(and(eq(requests.kind, "sweep"), eq(requests.status, "pending"), sql`${requests.input}->>'geohash' = ${tile}`))
          .limit(1)

        const requestId =
          pending?.id ??
          (
            await db
              .insert(requests)
              .values({
                userId: null,
                kind: "sweep",
                deadline: new Date(Date.now() + SWEEP_DEADLINE_MS),
                input: { geohash: tile, seeded: true, destination: dest.name },
              })
              .returning()
          )[0].id
        await queue.add("sweep", { requestId, geohash5: tile }, { jobId: `sweep-${tile}`, priority: "low" })
        tilesTouched++
      } else {
        tilesSkipped++
      }
    }
  }

  console.log(`Enqueued ${tilesTouched} tile fetches, skipped ${tilesSkipped} already-fresh ones.`)
  process.exit(0)
}

main().catch((e) => {
  console.error("Seed run failed:", e)
  process.exit(1)
})
