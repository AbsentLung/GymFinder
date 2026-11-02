// GET /v1/tiles/{geohash4} (API.md 2.2). The map loads gyms by fixed
// geohash4 tile; a stale or never-fetched tile still answers right
// away with whatever's in Postgres and enqueues a refresh for just the
// stale geohash5 cells inside it (API.md 1.5) rather than making the
// request wait on a live Overpass round-trip.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { sql, and, eq, inArray } from "drizzle-orm"
import { db } from "../db/index.js"
import { tileFetches } from "../db/schema.js"
import { queue } from "../queue/index.js"
import { geohash5ChildrenOf } from "../lib.js"

const GEOHASH4_PATTERN = /^[0-9b-hj-km-np-z]{4}$/

// "About a week" (STACK_AND_SCHEMA.md 2.5 / API.md 1.5).
const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Cut tiles down to a reasonable size (API.md 2.2: "description is cut
// to about 300 characters to keep tiles small").
const DESCRIPTION_MAX_CHARS = 300

interface GymRow {
  [key: string]: unknown
  id: number
  name: string
  lat: string
  lng: string
  address: string | null
  description: string | null
  categories: string[]
  accepts_drop_in: boolean | null
  has_trial: boolean | null
  day_pass: { amountMinor: number; currency: string; usdCents: number; verified: boolean } | null
  rating: number | null
}

export const tilesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/tiles/:geohash4",
    {
      schema: {
        params: z.object({ geohash4: z.string().regex(GEOHASH4_PATTERN, "must be a 4-character geohash") }),
      },
    },
    async (request, reply) => {
      const { geohash4 } = request.params
      const children = geohash5ChildrenOf(geohash4)

      const fetchRows = await db
        .select({ geohash: tileFetches.geohash, lastFetchedAt: tileFetches.lastFetchedAt })
        .from(tileFetches)
        .where(and(inArray(tileFetches.geohash, children), eq(tileFetches.source, "osm")))

      const fetchedCells = new Set(fetchRows.map((r) => r.geohash))
      const oldestFetchedAt =
        fetchRows.length > 0 ? Math.min(...fetchRows.map((r) => new Date(r.lastFetchedAt).getTime())) : null
      const missingCells = children.filter((c) => !fetchedCells.has(c))
      const isStale = missingCells.length > 0 || oldestFetchedAt === null || Date.now() - oldestFetchedAt > STALE_MS

      // Correlated subqueries for day-pass price and review-average
      // rating - a plain JOIN would multiply gym rows per price/review,
      // which a GROUP BY would then have to undo; a scalar subquery per
      // gym reads more directly and this table is read-heavy, not
      // write-heavy, so the extra per-row subquery cost is the right
      // tradeoff here. Raw sql, not the query builder - STACK_AND_SCHEMA.md
      // 1.3's own escape-hatch guidance for geo/aggregate queries Drizzle
      // can't express cleanly.
      const result = await db.execute<GymRow>(sql`
        SELECT g.id, g.name, ST_X(g.location) AS lng, ST_Y(g.location) AS lat, g.address, g.description,
               g.categories, g.accepts_drop_in, g.has_trial,
               (SELECT json_build_object('amountMinor', amount_minor, 'currency', currency, 'usdCents', usd_cents, 'verified', is_verified)
                FROM gym_prices WHERE gym_id = g.id AND kind = 'day_pass' ORDER BY is_verified DESC LIMIT 1) AS day_pass,
               (SELECT avg(rating)::float FROM reviews WHERE gym_id = g.id) AS rating
        FROM gyms g
        WHERE g.geohash4 = ${geohash4} AND g.status = 'active'
      `)

      const gyms = result.rows.map((g) => ({
        id: String(g.id),
        name: g.name,
        lat: Number(g.lat),
        lng: Number(g.lng),
        address: g.address,
        description: g.description ? g.description.slice(0, DESCRIPTION_MAX_CHARS) : null,
        categories: g.categories ?? [],
        acceptsDropIn: g.accepts_drop_in,
        hasTrial: g.has_trial,
        dayPass: g.day_pass,
        rating: g.rating,
      }))

      if (isStale) {
        for (const cell of missingCells.length > 0 ? missingCells : children) {
          // jobId dedupes - several requests hitting a stale tile at
          // once before the first refresh finishes only enqueue one job
          // per cell (DESIGN_DISCUSSION.md 5.3: "merge duplicate jobs,
          // same tile").
          await queue.add("tile-refresh", { geohash5: cell }, { jobId: `tile-refresh:${cell}` })
        }
      }

      reply.header("Cache-Control", "public, max-age=60, s-maxage=600, stale-while-revalidate=600")
      return {
        geohash: geohash4,
        fetchedAt: oldestFetchedAt ? new Date(oldestFetchedAt).toISOString() : null,
        stale: isStale,
        gyms,
      }
    }
  )
}
