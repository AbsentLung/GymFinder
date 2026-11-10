// GET /v1/tiles/{geohash4}. A stale or never-fetched tile still answers
// right away from Postgres and enqueues a refresh for the stale
// geohash5 cells, rather than waiting on a live Overpass round-trip.
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod"
import { z } from "zod"
import { sql, and, eq, inArray } from "drizzle-orm"
import { db } from "../db/index.js"
import { tileFetches } from "../db/schema.js"
import { queue } from "../queue/index.js"
import { geohash5ChildrenOf, isFetchRowFresh, toLocalDisplayPrice } from "../lib.js"
import { getFxRates } from "../fx.js"

const GEOHASH4_PATTERN = /^[0-9b-hj-km-np-z]{4}$/

const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Keeps tiles small.
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
  country_code: string | null
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

      const osmFetchRows = await db
        .select({ geohash: tileFetches.geohash, lastFetchedAt: tileFetches.lastFetchedAt, status: tileFetches.status })
        .from(tileFetches)
        .where(and(inArray(tileFetches.geohash, children), eq(tileFetches.source, "osm")))

      // fetchedAt counts any source (osm refresh or a sweep's own Google
      // Maps fetch) - a sweep should clear the nudge, not just Overpass.
      const anyFetchRows = await db
        .select({ lastFetchedAt: tileFetches.lastFetchedAt })
        .from(tileFetches)
        .where(inArray(tileFetches.geohash, children))

      const osmFetchRowByCell = new Map(osmFetchRows.map((r) => [r.geohash, r]))
      const oldestFetchedAt = anyFetchRows.length > 0 ? Math.min(...anyFetchRows.map((r) => new Date(r.lastFetchedAt).getTime())) : null
      // Per-cell, OSM-specific - only Overpass refresh is auto-enqueued below.
      const staleCells = children.filter((c) => !isFetchRowFresh(osmFetchRowByCell.get(c), STALE_MS))
      const isStale = staleCells.length > 0

      // Correlated subqueries, not a JOIN + GROUP BY - a plain JOIN would
      // multiply gym rows per price/review. Raw sql, not the query builder.
      const result = await db.execute<GymRow>(sql`
        SELECT g.id, g.name, ST_X(g.location) AS lng, ST_Y(g.location) AS lat, g.address, g.description,
               g.categories, g.accepts_drop_in, g.has_trial, g.country_code,
               (SELECT json_build_object('amountMinor', amount_minor, 'currency', currency, 'usdCents', usd_cents, 'verified', is_verified)
                FROM gym_prices WHERE gym_id = g.id AND kind = 'day_pass' ORDER BY is_verified DESC LIMIT 1) AS day_pass,
               (SELECT avg(rating)::float FROM reviews WHERE gym_id = g.id) AS rating
        FROM gyms g
        WHERE g.geohash4 = ${geohash4} AND g.status = 'active'
      `)

      // Stored as USD always - converted to each gym's local currency here.
      const rates = result.rows.some((g) => g.day_pass) ? await getFxRates() : {}

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
        dayPass: g.day_pass ? toLocalDisplayPrice(g.day_pass, g.country_code, rates) : null,
        rating: g.rating,
      }))

      for (const cell of staleCells) {
        // jobId dedupes several requests hitting a stale tile at once.
        // priority outranks the unprioritized (0) backlog from bulk seeding.
        await queue.add("tile-refresh", { geohash5: cell }, { jobId: `tile-refresh-${cell}`, priority: "normal" })
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
