// Location names end to end (LOCATION_NAMES.md), against the fixture regions in
// scripts/fixtures/regions.geojson. Runs once per MODE: pg-boss (demo) and BullMQ (scale).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { db, pool } from "../src/db/index.js"
import { MODE, config } from "../src/config.js"
import { queue } from "../src/queue/index.js"
import { upsertGym } from "../src/jobs/gym-upsert.js"
import {
  REGION_BACKFILL_QUEUE,
  GYM_REGION_PHOTON_QUEUE,
  GYM_REGION_QUEUE,
  processRegionBackfill,
  processGymRegion,
  processGymRegionPhoton,
} from "../src/jobs/gym-region.js"
import { buildApp } from "../src/api.js"

const UBUD = { lat: -8.51, lng: 115.27 }
const SURABAYA = { lat: -7.25, lng: 112.75 }
const HONG_KONG = { lat: 22.3, lng: 114.17 }
const SEA_PHOTON_BALI = { lat: -10.5, lng: 118.0 }
const SEA_PHOTON_UNKNOWN_STATE = { lat: -12.0, lng: 130.0 }
const SEA_PHOTON_DOWN = { lat: -11.0, lng: 119.0 }

// Photon is stubbed: fixed answers by latitude, a 503 for the "down" point.
const realFetch = globalThis.fetch
const photonCalls: string[] = []
function stubPhoton() {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith("https://photon.komoot.io/")) return realFetch(input, init)
    photonCalls.push(url)
    const lat = Number(new URL(url).searchParams.get("lat"))
    if (lat === SEA_PHOTON_DOWN.lat) return new Response("unavailable", { status: 503 })
    const properties =
      lat === SEA_PHOTON_UNKNOWN_STATE.lat ? { countrycode: "AU", state: "Nowhere State" } : { countrycode: "ID", state: "Bali" }
    return new Response(JSON.stringify({ features: [{ properties }] }), { headers: { "content-type": "application/json" } })
  })
}

let externalSeq = 0
async function addOsmGym(name: string, at: { lat: number; lng: number }, postcode: string | null = null) {
  const result = await upsertGym("osm", { externalId: `int-${MODE}-${++externalSeq}`, name, ...at, postcode })
  if (!result) throw new Error("upsertGym returned null")
  return result.gymId
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function gymRow(gymId: number) {
  const r = await db.execute<{ region_name: string | null; country_code: string | null; region_id: number | null }>(sql`
    SELECT r.name AS region_name, g.country_code, g.region_id FROM gyms g LEFT JOIN regions r ON r.id = g.region_id WHERE g.id = ${gymId}
  `)
  return r.rows[0]
}

const regionFilled = (row: { region_name: string | null } | undefined) => Boolean(row?.region_name)

async function placeOf(gymId: number) {
  const res = await app.inject({ method: "GET", url: `/v1/gyms/${gymId}` })
  expect(res.statusCode).toBe(200)
  return res.json().place
}

let app: FastifyInstance

beforeAll(async () => {
  stubPhoton()
  await queue.start()
  await queue.process<{ gymId: number }>(GYM_REGION_QUEUE, processGymRegion, { concurrency: 4 })
  await queue.process<{ gymId: number }>(GYM_REGION_PHOTON_QUEUE, processGymRegionPhoton)
  await queue.process<{ afterId: number }>(REGION_BACKFILL_QUEUE, processRegionBackfill)
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
  await queue.stop()
  await pool.end()
  vi.unstubAllGlobals()
})

describe(`gym regions (MODE=${MODE})`, () => {
  it("fills the containing region and keeps the OSM postcode", async () => {
    const gymId = await addOsmGym("Ubud Fitness", UBUD, "80571")
    const row = await waitFor(() => gymRow(gymId), regionFilled)
    expect(row.region_name).toBe("Bali")
    expect(row.country_code).toBe("ID")
    expect(await placeOf(gymId)).toEqual({ region: "Bali", country: "Indonesia", countryCode: "ID", postcode: "80571" })
  })

  it("gives a territory region its own country code", async () => {
    const gymId = await addOsmGym("Hong Kong Gym", HONG_KONG)
    const row = await waitFor(() => gymRow(gymId), regionFilled)
    expect(row.country_code).toBe("HK")
    expect(await placeOf(gymId)).toMatchObject({ countryCode: "HK", country: "Hong Kong SAR China" })
  })

  it("falls back to Photon outside every polygon and maps the state onto an existing region", async () => {
    const gymId = await addOsmGym("Island Gym", SEA_PHOTON_BALI)
    const row = await waitFor(() => gymRow(gymId), regionFilled)
    expect(row.region_name).toBe("Bali")
    expect(row.country_code).toBe("ID")
  })

  it("keeps Photon's country when its state matches no region", async () => {
    const gymId = await addOsmGym("Outback Gym", SEA_PHOTON_UNKNOWN_STATE)
    const row = await waitFor(() => gymRow(gymId), (r) => r?.country_code === "AU")
    expect(row.region_id).toBeNull()
    expect(await placeOf(gymId)).toEqual({ region: null, country: "Australia", countryCode: "AU", postcode: null })
  })

  it("leaves the gym saved with no region when Photon is down", async () => {
    const before = photonCalls.length
    const gymId = await addOsmGym("Remote Gym", SEA_PHOTON_DOWN)
    await waitFor(
      async () => photonCalls.slice(before).some((u) => u.includes(`lat=${SEA_PHOTON_DOWN.lat}`)),
      (called) => called
    )
    const row = await gymRow(gymId)
    expect(row).toBeDefined()
    expect(row.region_id).toBeNull()
  })

  it("refills the region when a refresh moves the gym", async () => {
    const externalId = `int-${MODE}-move`
    const first = await upsertGym("osm", { externalId, name: "Moving Gym", ...UBUD })
    const gymId = first!.gymId
    await waitFor(() => gymRow(gymId), (r) => r?.region_name === "Bali")
    await upsertGym("osm", { externalId, name: "Moving Gym", ...SURABAYA })
    const row = await waitFor(() => gymRow(gymId), (r) => r?.region_name === "East Java")
    expect(row.region_name).toBe("East Java")
  })

  it("backfills existing gyms that were written without a region", async () => {
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO gyms (name, location) VALUES ('Old Gym', ST_SetSRID(ST_MakePoint(${UBUD.lng}, ${UBUD.lat}), 4326)) RETURNING id
    `)
    const gymId = Number(inserted.rows[0].id)
    await queue.add(REGION_BACKFILL_QUEUE, { afterId: 0 }, { jobId: `region-backfill-test-${MODE}` })
    const row = await waitFor(() => gymRow(gymId), regionFilled)
    expect(row.region_name).toBe("Bali")
  })

  it("returns places in My requests and the admin list, including an add_gym with no gym yet", async () => {
    const email = `int-${MODE}-${Date.now()}@example.com`
    const signUp = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      headers: { origin: config.webOrigin, "content-type": "application/json" },
      payload: { email, password: "integration-password-1", name: "Integration" },
    })
    expect(signUp.statusCode).toBe(200)
    const cookie = [signUp.headers["set-cookie"]].flat().filter(Boolean).map((c) => String(c).split(";")[0]).join("; ")
    await db.execute(sql`UPDATE users SET role = 'admin' WHERE email = ${email}`)

    const created = await app.inject({
      method: "POST",
      url: "/v1/gyms",
      headers: { cookie, origin: config.webOrigin },
      payload: { name: "Proposed Ubud Gym", ...UBUD },
    })
    expect(created.statusCode).toBe(202)

    const mine = await app.inject({ method: "GET", url: "/v1/me/requests", headers: { cookie } })
    expect(mine.statusCode).toBe(200)
    const item = mine.json().items[0]
    expect(item.gymName).toBe("Proposed Ubud Gym")
    const change = item.changes[0]
    expect(change.gymId).toBeNull()
    expect(change.place).toMatchObject({ region: "Bali", country: "Indonesia" })

    const adminList = await app.inject({ method: "GET", url: "/v1/admin/changes", headers: { cookie } })
    expect(adminList.statusCode).toBe(200)
    const adminRow = adminList.json().items.find((i: { id: string }) => i.id === change.id)
    expect(adminRow.place).toMatchObject({ region: "Bali", country: "Indonesia" })
    expect(adminRow).not.toHaveProperty("locationLabel")

    // Approving creates the gym (bot-review.ts path), which then gets its region from the job.
    const approved = await app.inject({ method: "POST", url: `/v1/admin/changes/${change.id}/approve`, headers: { cookie } })
    expect(approved.statusCode).toBe(200)
    const newGym = await db.execute<{ id: number }>(sql`SELECT id FROM gyms WHERE name = 'Proposed Ubud Gym' ORDER BY id DESC LIMIT 1`)
    const row = await waitFor(() => gymRow(Number(newGym.rows[0].id)), regionFilled)
    expect(row.region_name).toBe("Bali")
  })
})
