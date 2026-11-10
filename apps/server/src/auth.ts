// Schema shape was pulled forward into Phase 3/4 for the migration
// script. This file is the actual auth wiring; routes mount in
// src/routes/auth.ts.
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import bcrypt from "bcryptjs"
import { db, schema } from "./db/index.js"
import { config } from "./config.js"

export const auth = betterAuth({
  baseURL: config.betterAuthUrl,
  // Default is "/api/auth" - without this, every path mounted at
  // /v1/auth/* 404s (Better Auth parses against its own basePath).
  basePath: "/v1/auth",
  // Merges with the real `users` table instead of generating a
  // conflicting one of its own.
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
  // Google and Facebook at launch; Apple comes before the iOS release.
  // Optional in local dev - undefined until a provider is registered.
  socialProviders: {
    ...(config.googleClientId && config.googleClientSecret
      ? { google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret } }
      : {}),
    ...(config.facebookClientId && config.facebookClientSecret
      ? { facebook: { clientId: config.facebookClientId, clientSecret: config.facebookClientSecret } }
      : {}),
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
