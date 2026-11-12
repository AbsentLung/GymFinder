// Fresh throwaway database per run: create, migrate, load the fixture regions.
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..")

export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/gymfinder_test")
  const dbName = url.pathname.slice(1)
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to reset "${dbName}": integration tests only use a *_test database`)

  const adminUrl = new URL(url)
  adminUrl.pathname = "/postgres"
  const admin = new pg.Client({ connectionString: adminUrl.toString() })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${dbName}"`)
  await admin.end()

  const pool = new pg.Pool({ connectionString: url.toString() })
  await migrate(drizzle(pool), { migrationsFolder: join(serverDir, "drizzle") })
  await pool.end()

  execFileSync("npx", ["tsx", "scripts/seed-regions.ts", "--fixture"], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: url.toString(), MODE: "demo" },
    stdio: "inherit",
  })
}
