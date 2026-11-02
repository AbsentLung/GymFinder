// Pulled forward from Phase 5 (full auth wiring - mounting routes,
// session middleware, Google/Facebook/Apple providers - is still that
// phase's job) because Phase 4's migration script needs the real table
// shapes (`users` columns, `account.password`) to exist before it can
// write into them. Verified live against this exact schema file via
// `npx @better-auth/cli generate` (see src/db/schema.ts's comment on the
// `users`/`session`/`account`/`verification` tables for what that run
// actually confirmed).
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/node-postgres"
import bcrypt from "bcryptjs"
import pg from "pg"
import * as schema from "./db/schema.js"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })

export const auth = betterAuth({
  // Passing `schema` (confirmed against the current docs, not memory) is
  // what makes `generate` merge with the REAL `users` table (bigint id,
  // `role` column) instead of inventing its own idealized one from
  // scratch - without it, the first attempt here produced a second,
  // conflicting `users` definition with a text id and no `role` at all.
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    // The demo's existing accounts were hashed with bcryptjs
    // (apps/server/server/index.js). Better Auth's default hashing
    // (scrypt) can't verify those, but it explicitly supports swapping
    // in a custom hash/verify pair (confirmed against the current docs,
    // not memory) - pointing both at bcryptjs means every migrated
    // account keeps working with its existing password, no forced
    // resets, and new signups keep using the same scheme as the ones
    // migrated in from the demo.
    password: {
      hash: (password) => bcrypt.hash(password, 10),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
  },
  // Better Auth defaults to its own "user" table with text/string IDs -
  // STACK_AND_SCHEMA.md 2.13 already decided bigint IDs for every table,
  // including `users`. modelName remaps the table to the one this app
  // already has.
  user: { modelName: "users" },
  // Global, not scoped to just "users" - Better Auth's own session/
  // account/verification tables FK against users.id, so if only users
  // got bigint ids, those FK columns would still come out as text
  // (type-mismatched against a bigint PK). "serial" everywhere keeps
  // every Better-Auth-owned table internally consistent and matches
  // STACK_AND_SCHEMA.md 2.13's bigint-everywhere decision, not just for
  // users (confirmed against the current docs, not memory).
  advanced: {
    database: {
      generateId: "serial",
    },
  },
})
