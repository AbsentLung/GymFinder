// One pool, one Drizzle instance, shared by every route/worker/auth
// config - not re-created per module (auth.ts used to open its own
// separate pool to the same database; consolidated here instead).
import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { config } from "../config.js"
import * as schema from "./schema.js"

export const pool = new pg.Pool({ connectionString: config.databaseUrl })
export const db = drizzle(pool, { schema })
export { schema }
