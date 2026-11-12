// Loads state / province / island polygons into `regions` (LOCATION_NAMES.md).
// Separate from migrations: the world load is a ~100 MB download.
//
// Usage:
//   DATABASE_URL=... npm run seed:regions -- --fixture             (tests / CI)
//   DATABASE_URL=... npm run seed:regions                          (whole world)
//   DATABASE_URL=... npm run seed:regions -- --countries=IDN,THA   (subset, ISO3)
//
// The world load needs `shp2pgsql`, `psql` and `unzip` on PATH (shp2pgsql
// ships with PostGIS). Re-runnable: rows upsert by source_ref.
import { spawn, execFile } from "node:child_process"
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { db, pool } from "../src/db/index.js"
import { config } from "../src/config.js"
import { TERRITORY_OVERRIDES, decodeDbfText, iso3ToIso2 } from "../src/regions.js"

// geoBoundaries CGAZ ADM1 (CC BY 4.0, attribution required).
const CGAZ_ADM1_URL = "https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/CGAZ/geoBoundariesCGAZ_ADM1.zip"
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "regions.geojson")
const INSERT_BATCH = 200

const execFileAsync = promisify(execFile)

const FixtureSchema = z.object({
  features: z.array(
    z.object({ properties: z.object({ sourceRef: z.string(), name: z.string(), iso3: z.string() }), geometry: z.unknown() })
  ),
})

async function createLoadTable() {
  await db.execute(sql`DROP TABLE IF EXISTS regions_load`)
  await db.execute(sql`
    CREATE UNLOGGED TABLE regions_load (source_ref text PRIMARY KEY, name text NOT NULL, iso3 text NOT NULL, geom geometry NOT NULL)
  `)
}

async function loadFixture() {
  const parsed = FixtureSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")))
  const rows = parsed.features.map((f) => ({ ...f.properties, geometry: JSON.stringify(f.geometry) }))
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db.execute(sql`
      INSERT INTO regions_load (source_ref, name, iso3, geom)
      SELECT r->>'sourceRef', r->>'name', r->>'iso3', ST_SetSRID(ST_GeomFromGeoJSON(r->>'geometry'), 4326)
      FROM jsonb_array_elements(${JSON.stringify(rows.slice(i, i + INSERT_BATCH))}::jsonb) r
    `)
  }
  console.log(`Fixture: ${rows.length} regions staged`)
}

async function download(url: string, path: string) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`)
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path))
}

function exitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
}

// shp2pgsql | psql - the boring way to get a shapefile into PostGIS.
// LATIN1 keeps every raw byte; decodeStagedNames sorts out the mixed
// UTF-8 / Windows-1252 names afterwards.
async function shapefileToTable(shpPath: string, table: string): Promise<void> {
  const shp = spawn("shp2pgsql", ["-W", "LATIN1", "-d", "-D", "-s", "4326", shpPath, table], { stdio: ["ignore", "pipe", "pipe"] })
  const psql = spawn("psql", [config.databaseUrl, "-q", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  shp.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
  psql.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
  shp.stdout.pipe(psql.stdin)
  const [shpCode, psqlCode] = await Promise.all([exitCode(shp), exitCode(psql)])
  if (shpCode !== 0 || psqlCode !== 0) throw new Error(`Loading ${shpPath} failed (shp2pgsql ${shpCode}, psql ${psqlCode}): ${stderr}`)
}

async function loadCgaz(countries: string[] | null) {
  const workDir = mkdtempSync(join(tmpdir(), "regions-"))
  try {
    const zipPath = join(workDir, "ADM1.zip")
    console.log("CGAZ ADM1: downloading...")
    await download(CGAZ_ADM1_URL, zipPath)
    await execFileAsync("unzip", ["-q", "-o", zipPath, "-d", workDir])
    const shp = readdirSync(workDir).find((f) => f.endsWith(".shp"))
    if (!shp) throw new Error(`No .shp in ${zipPath}`)
    await shapefileToTable(join(workDir, shp), "regions_load_raw")
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  const countryFilter = countries ? sql`AND shapegroup IN (${sql.join(countries.map((c) => sql`${c}`), sql`, `)})` : sql``
  await db.execute(sql`
    INSERT INTO regions_load (source_ref, name, iso3, geom)
    SELECT 'cgaz:ADM1:' || shapeid, n.name, shapegroup, geom FROM regions_load_raw
    -- Some names carry stray tabs/newlines (e.g. Hanoi); some are blank.
    CROSS JOIN LATERAL (SELECT regexp_replace(shapename, '^\\s+|\\s+$', '', 'g') AS name) n
    WHERE n.name <> '' ${countryFilter}
    ON CONFLICT (source_ref) DO NOTHING
  `)
  await db.execute(sql`DROP TABLE regions_load_raw`)
  await decodeStagedNames()
}

async function decodeStagedNames() {
  const rows = await db.execute<{ source_ref: string; name: string }>(sql`
    SELECT source_ref, name FROM regions_load WHERE name ~ '[\u0080-ÿ]'
  `)
  for (const row of rows.rows) {
    const decoded = decodeDbfText(row.name)
    if (decoded !== row.name) await db.execute(sql`UPDATE regions_load SET name = ${decoded} WHERE source_ref = ${row.source_ref}`)
  }
}

async function upsertStagedRegions() {
  const iso3Rows = await db.execute<{ iso3: string }>(sql`SELECT DISTINCT iso3 FROM regions_load`)
  const isoMap: Record<string, string> = {}
  for (const { iso3 } of iso3Rows.rows) {
    const iso2 = iso3ToIso2(iso3)
    if (iso2) isoMap[iso3] = iso2
    else console.log(`Skipping regions with country key "${iso3}" (no ISO 3166-1 code, e.g. a disputed area)`)
  }

  await db.execute(sql`
    INSERT INTO regions (name, country_code, geom, source_ref)
    SELECT l.name, m.value, g.geom, l.source_ref
    FROM regions_load l
    JOIN jsonb_each_text(${JSON.stringify(isoMap)}::jsonb) m ON m.key = l.iso3
    CROSS JOIN LATERAL (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(l.geom), 3)) AS geom) g
    WHERE NOT ST_IsEmpty(g.geom)
    ON CONFLICT (source_ref) DO UPDATE SET name = excluded.name, country_code = excluded.country_code, geom = excluded.geom
  `)

  // After the upsert, which resets country_code from the file each run.
  for (const t of TERRITORY_OVERRIDES) {
    await db.execute(sql`
      UPDATE regions SET country_code = ${t.iso2}
      WHERE country_code = ${t.parentIso2} AND name = ${t.name} AND source_ref IN (SELECT source_ref FROM regions_load)
    `)
  }
}

function parseCountries(): string[] | null {
  const arg = process.argv.find((a) => a.startsWith("--countries="))
  if (!arg) return null
  return arg
    .slice("--countries=".length)
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
}

async function main() {
  await createLoadTable()
  if (process.argv.includes("--fixture")) await loadFixture()
  else await loadCgaz(parseCountries())
  await upsertStagedRegions()
  const count = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM regions`)
  console.log(`regions: ${count.rows[0].n}`)
  await db.execute(sql`DROP TABLE regions_load`)
}

main()
  .catch((e) => {
    console.error("seed:regions failed:", e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
