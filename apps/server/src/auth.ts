// Schema shape was pulled forward into Phase 3/4 for the migration
// script. This file is the actual auth wiring; routes mount in
// src/routes/auth.ts.
import { betterAuth } from "better-auth"
import { expo } from "@better-auth/expo"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import bcrypt from "bcryptjs"
import { db, schema } from "./db/index.js"
import { config } from "./config.js"

export const auth = betterAuth({
  baseURL: config.betterAuthUrl,
  // Default is "/api/auth" - without this, every path mounted at
  // /v1/auth/* 404s (Better Auth parses against its own basePath).
  basePath: "/v1/auth",
  // Lets Better Auth recognize requests from the Expo app's own scheme,
  // not just a real browser origin.
  plugins: [expo()],
  // NODE_ENV, not MODE - MODE=demo is a real production tier, so
  // trusting any exp:// dev-tunnel origin there would be a real hole.
  // config.webOrigin covers the web app, checked on every platform.
  trustedOrigins: [
    "travelapp://",
    config.webOrigin,
    ...(process.env.NODE_ENV !== "production" ? ["exp://", "exp://**", "exp://192.168.*.*:*/**"] : []),
  ],
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
  user: {
    modelName: "users",
    // Without this, `role` is invisible to auth.api.getSession() even
    // though the column exists - additionalFields is what exposes it.
    // input: false - only PATCH /v1/admin/users/{id} can change it.
    additionalFields: { role: { type: "string", input: false, defaultValue: "user" } },
  },
  // Keeps every Better-Auth-owned table on bigint ids too, so their FKs
  // against users.id aren't type-mismatched.
  advanced: {
    database: {
      generateId: "serial",
    },
  },
})
