// Pulled forward from Phase 5 - Phase 4's migration needs the real
// table shapes (account.password) to exist before writing into them.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/node-postgres"
import bcrypt from "bcryptjs"
import pg from "pg"
import * as schema from "./db/schema.js"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })

export const auth = betterAuth({
  // Passing `schema` merges with the real `users` table instead of
  // generating a conflicting one of its own.
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    // Demo accounts were hashed with bcryptjs - pointing both hash/verify
    // at it keeps migrated passwords working with no forced reset.
    password: {
      hash: (password) => bcrypt.hash(password, 10),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
  },
  // Remaps Better Auth's default text-id "user" table onto this app's
  // bigint-id `users`.
  user: { modelName: "users" },
  // Keeps every Better-Auth-owned table on bigint ids too, so their FKs
  // against users.id aren't type-mismatched.
  advanced: {
    database: {
      generateId: "serial",
    },
  },
})
