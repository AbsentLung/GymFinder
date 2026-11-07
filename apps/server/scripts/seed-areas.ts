// Loads boundary polygons into `areas` (LOCATION_NAMES.md). Separate from
// migrations: the full world load is a large one-off download.
//
// Usage:
//   DATABASE_URL=... npm run seed:areas -- --fixture             (tests / CI)
//   DATABASE_URL=... npm run seed:areas                          (whole world)
//   DATABASE_URL=... npm run seed:areas -- --countries=IDN,THA   (subset, ISO3)
//
// The full load needs `shp2pgsql`, `psql` and `unzip` on PATH (shp2pgsql
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
import { AREA_LEVELS, type AreaLevel } from "../src/db/schema.js"
import { AREA_DEPTH, TERRITORY_OVERRIDES, decodeDbfText, iso3ToIso2, isAllowedBoundaryLicense } from "../src/areas.js"

const CGAZ_BASE = "https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/CGAZ"
const CGAZ_LEVELS: ReadonlyArray<{ adm: string; level: AreaLevel }> = [
  { adm: "ADM0", level: "country" },
  { adm: "ADM1", level: "region" },
  { adm: "ADM2", level: "county" },
]
const GBOPEN_CITY_LISTING = "https://www.geoboundaries.org/api/current/gbOpen/ALL/ADM3/"
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "areas.geojson")
const INSERT_BATCH = 200

const execFileAsync = promisify(execFile)

const FeatureCollectionSchema = <P extends z.ZodTypeAny>(props: P) =>
  z.object({ features: z.array(z.object({ properties: props, geometry: z.unknown() })) })

const FixturePropsSchema = z.object({
  sourceRef: z.string(),
  name: z.string(),
  level: z.enum(AREA_LEVELS),
  iso3: z.string(),
})

const GbOpenPropsSchema = z.object({ shapeName: z.string(), shapeID: z.string() }).passthrough()

const GbOpenListingSchema = z.array(
  z.object({ boundaryISO: z.string(), boundaryLicense: z.string(), simplifiedGeometryGeoJSON: z.string().url() })
)

interface LoadRow {
  sourceRef: string
  name: string
  level: AreaLevel
  iso3: string
  geometry: unknown
}

async function createLoadTable() {
  await db.execute(sql`DROP TABLE IF EXISTS areas_load`)
  await db.execute(sql`
    CREATE UNLOGGED TABLE areas_load (source_ref text PRIMARY KEY, name text NOT NULL, level text NOT NULL, iso3 text NOT NULL, geom geometry NOT NULL)
  `)
}

async function insertLoadRows(rows: LoadRow[]) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH).map((r) => ({ ...r, geometry: JSON.stringify(r.geometry) }))
    await db.execute(sql`
      INSERT INTO areas_load (source_ref, name, level, iso3, geom)
      SELECT r->>'sourceRef', r->>'name', r->>'level', r->>'iso3', ST_SetSRID(ST_GeomFromGeoJSON(r->>'geometry'), 4326)
      FROM jsonb_array_elements(${JSON.stringify(batch)}::jsonb) r
      ON CONFLICT (source_ref) DO NOTHING
    `)
  }
}

async function loadFixture() {
  const parsed = FeatureCollectionSchema(FixturePropsSchema).parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")))
  await insertLoadRows(parsed.features.map((f) => ({ ...f.properties, geometry: f.geometry })))
  console.log(`Fixture: ${parsed.features.length} areas staged`)
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
// LATIN1 keeps every raw byte; decodeStagedCgazNames sorts out the mixed
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

async function loadCgaz(workDir: string, countries: string[] | null) {
  for (const { adm, level } of CGAZ_LEVELS) {
    const zipPath = join(workDir, `${adm}.zip`)
    console.log(`CGAZ ${adm}: downloading...`)
    await download(`${CGAZ_BASE}/geoBoundariesCGAZ_${adm}.zip`, zipPath)
    const unzipDir = join(workDir, adm)
    await execFileAsync("unzip", ["-q", "-o", zipPath, "-d", unzipDir])
    const shp = readdirSync(unzipDir).find((f) => f.endsWith(".shp"))
    if (!shp) throw new Error(`No .shp in ${zipPath}`)
    await shapefileToTable(join(unzipDir, shp), "areas_load_raw")

    // ADM0 has no shapeID column; one row per country, so the ISO3 key is unique.
    const idColumn = adm === "ADM0" ? sql.raw("shapegroup") : sql.raw("shapeid")
    const countryFilter = countries ? sql`AND shapegroup IN (${sql.join(countries.map((c) => sql`${c}`), sql`, `)})` : sql``
    // Some ADM2 polygons are unnamed; gyms there fall back to the region.
    await db.execute(sql`
      INSERT INTO areas_load (source_ref, name, level, iso3, geom)
      SELECT ${`cgaz:${adm}:`} || ${idColumn}, btrim(shapename), ${level}, shapegroup, geom FROM areas_load_raw
      WHERE btrim(shapename) <> '' ${countryFilter}
      ON CONFLICT (source_ref) DO NOTHING
    `)
    await db.execute(sql`DROP TABLE areas_load_raw`)
    rmSync(unzipDir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
  }
}

async function loadGbOpenCities(countries: string[] | null) {
  const listing = GbOpenListingSchema.parse(await (await fetch(GBOPEN_CITY_LISTING)).json())
  for (const entry of listing) {
    if (countries && !countries.includes(entry.boundaryISO)) continue
    if (!isAllowedBoundaryLicense(entry.boundaryLicense)) {
      console.log(`gbOpen ADM3 ${entry.boundaryISO}: skipped, license "${entry.boundaryLicense}"`)
      continue
    }
    const res = await fetch(entry.simplifiedGeometryGeoJSON)
    if (!res.ok) {
      console.warn(`gbOpen ADM3 ${entry.boundaryISO}: download failed (${res.status}), skipped`)
      continue
    }
    const collection = FeatureCollectionSchema(GbOpenPropsSchema).parse(await res.json())
    await insertLoadRows(
      collection.features.map((f) => ({
        sourceRef: `gbOpen:ADM3:${f.properties.shapeID}`,
        name: f.properties.shapeName,
        level: "city",
        iso3: entry.boundaryISO,
        geometry: f.geometry,
      }))
    )
    console.log(`gbOpen ADM3 ${entry.boundaryISO}: ${collection.features.length} cities staged`)
  }
}

async function upsertStagedAreas() {
  const iso3Rows = await db.execute<{ iso3: string }>(sql`SELECT DISTINCT iso3 FROM areas_load`)
  const isoMap: Record<string, string> = {}
  for (const { iso3 } of iso3Rows.rows) {
    const iso2 = iso3ToIso2(iso3)
    if (iso2) isoMap[iso3] = iso2
    else console.log(`Skipping areas with country key "${iso3}" (no ISO 3166-1 code, e.g. a disputed area)`)
  }

  await db.execute(sql`
    INSERT INTO areas (name, level, country_code, geom, source_ref)
    SELECT l.name, l.level, m.value, g.geom, l.source_ref
    FROM areas_load l
    JOIN jsonb_each_text(${JSON.stringify(isoMap)}::jsonb) m ON m.key = l.iso3
    CROSS JOIN LATERAL (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(l.geom), 3)) AS geom) g
    WHERE NOT ST_IsEmpty(g.geom)
    ON CONFLICT (source_ref) DO UPDATE SET name = excluded.name, level = excluded.level, country_code = excluded.country_code, geom = excluded.geom
  `)
}

async function decodeStagedCgazNames() {
  const rows = await db.execute<{ source_ref: string; name: string }>(sql`
    SELECT source_ref, name FROM areas_load WHERE source_ref LIKE 'cgaz:%' AND name ~ '[\u0080-ÿ]'
  `)
  for (const row of rows.rows) {
    const decoded = decodeDbfText(row.name)
    if (decoded !== row.name) await db.execute(sql`UPDATE areas_load SET name = ${decoded} WHERE source_ref = ${row.source_ref}`)
  }
}

async function promoteTerritories() {
  for (const t of TERRITORY_OVERRIDES) {
    await db.execute(sql`
      UPDATE areas SET level = 'country', country_code = ${t.iso2}, parent_id = NULL
      WHERE level = 'region' AND country_code = ${t.parentIso2} AND name = ${t.name}
    `)
  }
}

// Parent = the deepest shallower area containing a point inside the child,
// tried one parent level at a time (nearest first) so huge country
// outlines are only tested when nothing smaller matched. Top-down, so a
// county under Hong Kong inherits HK, not China's CN.
async function linkParents() {
  await db.execute(sql`UPDATE areas SET parent_id = NULL WHERE source_ref IN (SELECT source_ref FROM areas_load)`)
  for (const level of AREA_LEVELS.filter((l) => l !== "country")) {
    await db.execute(sql`DROP TABLE IF EXISTS areas_link_points`)
    await db.execute(sql`
      CREATE UNLOGGED TABLE areas_link_points AS
      SELECT a.id, ST_PointOnSurface(a.geom) AS pt FROM areas a
      WHERE a.level = ${level} AND a.source_ref IN (SELECT source_ref FROM areas_load)
    `)
    const parentLevels = AREA_LEVELS.filter((p) => AREA_DEPTH[p] < AREA_DEPTH[level]).sort((a, b) => AREA_DEPTH[b] - AREA_DEPTH[a])
    for (const parentLevel of parentLevels) {
      await db.execute(sql`
        UPDATE areas c SET parent_id = (
          SELECT p.id FROM areas p WHERE p.level = ${parentLevel} AND ST_Intersects(p.geom, lp.pt) ORDER BY ST_Area(p.geom) ASC LIMIT 1
        )
        FROM areas_link_points lp
        WHERE c.id = lp.id AND c.parent_id IS NULL
      `)
    }
    await db.execute(sql`DROP TABLE areas_link_points`)
    await db.execute(sql`
      UPDATE areas c SET country_code = p.country_code FROM areas p
      WHERE c.parent_id = p.id AND c.level = ${level} AND c.country_code <> p.country_code
        AND c.source_ref IN (SELECT source_ref FROM areas_load)
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
  const fixture = process.argv.includes("--fixture")
  const countries = parseCountries()
  await createLoadTable()

  if (fixture) {
    await loadFixture()
  } else {
    const workDir = mkdtempSync(join(tmpdir(), "areas-"))
    try {
      await loadCgaz(workDir, countries)
      await decodeStagedCgazNames()
      await loadGbOpenCities(countries)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  await upsertStagedAreas()
  await promoteTerritories()
  await linkParents()
  const counts = await db.execute<{ level: string; n: number }>(sql`SELECT level, count(*)::int AS n FROM areas GROUP BY level ORDER BY level`)
  console.log("areas:", Object.fromEntries(counts.rows.map((r) => [r.level, r.n])))
  await db.execute(sql`DROP TABLE areas_load`)
}

main()
  .catch((e) => {
    console.error("seed:areas failed:", e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
