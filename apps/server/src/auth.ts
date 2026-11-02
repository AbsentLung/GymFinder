// Schema shape (users columns, account.password) was pulled forward
// into Phase 3/4 since the migration script needed it to exist before
// writing into it - see src/db/schema.ts's comment. This file is the
// actual auth wiring: routes are mounted in src/routes/auth.ts.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import bcrypt from "bcryptjs"
import { db, schema } from "./db/index.js"
import { config } from "./config.js"

export const auth = betterAuth({
  baseURL: config.betterAuthUrl,
  // Default is "/api/auth" - without this, Better Auth's own handler
  // 404s on every path mounted at /v1/auth/* (caught live: it parses
  // the incoming URL against whatever basePath it's configured with,
  // not just "whatever Fastify happened to route to it").
  basePath: "/v1/auth",
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
  // Google and Facebook at launch (API.md 2.1 decision #7); Apple is
  // added separately before the iOS release (Apple requires it once
  // other social logins exist). Optional in local dev - undefined until
  // there's a real registered OAuth app for each provider, so this
  // can't crash a demo-mode server that doesn't have one yet.
  socialProviders: {
    ...(config.googleClientId && config.googleClientSecret
      ? { google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret } }
      : {}),
    ...(config.facebookClientId && config.facebookClientSecret
      ? { facebook: { clientId: config.facebookClientId, clientSecret: config.facebookClientSecret } }
      : {}),
  },
  // Better Auth defaults to its own "user" table with text/string IDs -
  // STACK_AND_SCHEMA.md 2.13 already decided bigint IDs for every table,
  // including `users`. modelName remaps the table to the one this app
  // already has.
  user: {
    modelName: "users",
    // Without this, `role` is invisible to Better Auth's own API even
    // though the column is right there on the mapped table - caught
    // live (src/auth-guard.ts's requireAdmin): auth.api.getSession()
    // only returns fields it's been told about via additionalFields,
    // silently dropping any other column the underlying table happens
    // to have. input: false - only PATCH /v1/admin/users/{id} (which
    // writes the column directly, not through Better Auth's own APIs)
    // is allowed to change it; nothing lets a user set their own role at
    // sign-up.
    additionalFields: { role: { type: "string", input: false, defaultValue: "user" } },
  },
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
