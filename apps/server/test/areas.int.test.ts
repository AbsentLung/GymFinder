// Location names end to end (LOCATION_NAMES.md), against the fixture areas in
// scripts/fixtures/areas.geojson. Runs once per MODE: pg-boss (demo) and BullMQ (scale).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"
import { db, pool } from "../src/db/index.js"
import { MODE } from "../src/config.js"
import { queue } from "../src/queue/index.js"
import { upsertGym } from "../src/jobs/gym-upsert.js"
import {
  AREA_BACKFILL_QUEUE,
  GYM_AREA_PHOTON_QUEUE,
  GYM_AREA_QUEUE,
  processAreaBackfill,
  processGymArea,
  processGymAreaPhoton,
} from "../src/jobs/gym-area.js"
import { buildApp } from "../src/api.js"
import { config } from "../src/config.js"

const UBUD = { lat: -8.51, lng: 115.27 }
const BADUNG = { lat: -8.7, lng: 115.1 }
const WAN_CHAI = { lat: 22.275, lng: 114.18 }
const SEA_PHOTON_OK = { lat: -10.5, lng: 118.0 }
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
    const properties = { countrycode: "ID", state: "Bali", county: "Gianyar", city: "Ubud" }
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
  const r = await db.execute<{ area_name: string | null; country_code: string | null; area_id: number | null }>(sql`
    SELECT a.name AS area_name, g.country_code, g.area_id FROM gyms g LEFT JOIN areas a ON a.id = g.area_id WHERE g.id = ${gymId}
  `)
  return r.rows[0]
}

const areaFilled = (row: { area_name: string | null } | undefined) => Boolean(row?.area_name)

let app: FastifyInstance

beforeAll(async () => {
  stubPhoton()
  await queue.start()
  await queue.process<{ gymId: number }>(GYM_AREA_QUEUE, processGymArea, { concurrency: 4 })
  await queue.process<{ gymId: number }>(GYM_AREA_PHOTON_QUEUE, processGymAreaPhoton)
  await queue.process<{ afterId: number }>(AREA_BACKFILL_QUEUE, processAreaBackfill)
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
  await queue.stop()
  await pool.end()
  vi.unstubAllGlobals()
})

describe(`gym areas (MODE=${MODE})`, () => {
  it("fills the deepest containing area and keeps the OSM postcode", async () => {
    const gymId = await addOsmGym("Ubud Fitness", UBUD, "80571")
    const row = await waitFor(() => gymRow(gymId), areaFilled)
    expect(row.area_name).toBe("Ubud")
    expect(row.country_code).toBe("ID")

    const res = await app.inject({ method: "GET", url: `/v1/gyms/${gymId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().place).toEqual({
      city: "Ubud",
      county: "Gianyar",
      region: "Bali",
      country: "Indonesia",
      countryCode: "ID",
      postcode: "80571",
    })
  })

  it("stops at the county where there is no city polygon", async () => {
    const gymId = await addOsmGym("Badung Gym", BADUNG)
    const row = await waitFor(() => gymRow(gymId), areaFilled)
    expect(row.area_name).toBe("Badung")
    const place = (await app.inject({ method: "GET", url: `/v1/gyms/${gymId}` })).json().place
    expect(place).toMatchObject({ city: null, county: "Badung", region: "Bali", country: "Indonesia" })
  })

  it("puts a gym in a promoted territory under its own country code", async () => {
    const gymId = await addOsmGym("Wan Chai Gym", WAN_CHAI)
    const row = await waitFor(() => gymRow(gymId), areaFilled)
    expect(row.area_name).toBe("Wan Chai")
    expect(row.country_code).toBe("HK")
    const place = (await app.inject({ method: "GET", url: `/v1/gyms/${gymId}` })).json().place
    expect(place).toMatchObject({ county: "Wan Chai", region: null, countryCode: "HK", country: "Hong Kong SAR China" })
  })

  it("falls back to Photon outside every polygon and maps onto existing areas", async () => {
    const gymId = await addOsmGym("Island Gym", SEA_PHOTON_OK)
    const row = await waitFor(() => gymRow(gymId), areaFilled)
    expect(row.area_name).toBe("Ubud")
    expect(row.country_code).toBe("ID")
  })

  it("leaves the gym saved with no area when Photon is down", async () => {
    const before = photonCalls.length
    const gymId = await addOsmGym("Remote Gym", SEA_PHOTON_DOWN)
    await waitFor(
      async () => photonCalls.slice(before).some((u) => u.includes(`lat=${SEA_PHOTON_DOWN.lat}`)),
      (called) => called
    )
    const row = await gymRow(gymId)
    expect(row).toBeDefined()
    expect(row.area_id).toBeNull()
  })

  it("refills the area when a refresh moves the gym", async () => {
    const externalId = `int-${MODE}-move`
    const first = await upsertGym("osm", { externalId, name: "Moving Gym", ...UBUD })
    const gymId = first!.gymId
    await waitFor(() => gymRow(gymId), (r) => r?.area_name === "Ubud")
    await upsertGym("osm", { externalId, name: "Moving Gym", ...BADUNG })
    const row = await waitFor(() => gymRow(gymId), (r) => r?.area_name === "Badung")
    expect(row.area_name).toBe("Badung")
  })

  it("backfills existing gyms that were written without an area", async () => {
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO gyms (name, location) VALUES ('Old Gym', ST_SetSRID(ST_MakePoint(${UBUD.lng}, ${UBUD.lat}), 4326)) RETURNING id
    `)
    const gymId = Number(inserted.rows[0].id)
    await queue.add(AREA_BACKFILL_QUEUE, { afterId: 0 }, { jobId: `area-backfill-test-${MODE}` })
    const row = await waitFor(() => gymRow(gymId), areaFilled)
    expect(row.area_name).toBe("Ubud")
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
    expect(change.place).toMatchObject({ city: "Ubud", region: "Bali", country: "Indonesia" })

    const adminList = await app.inject({ method: "GET", url: "/v1/admin/changes", headers: { cookie } })
    expect(adminList.statusCode).toBe(200)
    const adminRow = adminList.json().items.find((i: { id: string }) => i.id === change.id)
    expect(adminRow.place).toMatchObject({ city: "Ubud", country: "Indonesia" })
    expect(adminRow).not.toHaveProperty("locationLabel")

    // Approving creates the gym (bot-review.ts path), which then gets its area from the job.
    const approved = await app.inject({ method: "POST", url: `/v1/admin/changes/${change.id}/approve`, headers: { cookie } })
    expect(approved.statusCode).toBe(200)
    const newGym = await db.execute<{ id: number }>(sql`SELECT id FROM gyms WHERE name = 'Proposed Ubud Gym' ORDER BY id DESC LIMIT 1`)
    const row = await waitFor(() => gymRow(Number(newGym.rows[0].id)), areaFilled)
    expect(row.area_name).toBe("Ubud")
  })
})
