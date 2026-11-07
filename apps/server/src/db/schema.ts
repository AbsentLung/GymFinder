// Real schema per STACK_AND_SCHEMA.md part 2. The old apps/server/db/*.sql
// is the vibe-coded demo, kept as reference only.

import { sql, type SQL } from "drizzle-orm"
import {
  pgTable,
  bigint,
  bigserial,
  text,
  boolean,
  jsonb,
  timestamp,
  date,
  integer,
  smallint,
  customType,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

// Drizzle has no built-in PostGIS type - customType escape hatch.
// fromDriver is a pass-through: reads come back as raw EWKB hex, not
// {lat,lng}, unless the query selects ST_X/ST_Y explicitly.
const point = customType<{ data: { lat: number; lng: number }; driverData: string }>({
  dataType() {
    return "geometry(Point, 4326)"
  },
  toDriver(value): SQL {
    return sql`ST_SetSRID(ST_MakePoint(${value.lng}, ${value.lat}), 4326)`
  },
  fromDriver(value) {
    return value as unknown as { lat: number; lng: number }
  },
})

// Only ever written and read through raw SQL (seed script, ST_Contains).
const multiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(MultiPolygon, 4326)"
  },
})

export const AREA_LEVELS = ["country", "region", "county", "city"] as const
export type AreaLevel = (typeof AREA_LEVELS)[number]

// Boundary polygons (LOCATION_NAMES.md). Named "areas", not "admin_*",
// so it never reads like the admin role.
export const areas = pgTable(
  "areas",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    level: text("level").$type<AreaLevel>().notNull(),
    parentId: bigint("parent_id", { mode: "number" }).references((): AnyPgColumn => areas.id, { onDelete: "set null" }),
    countryCode: text("country_code").notNull(),
    geom: multiPolygon("geom").notNull(),
    // e.g. "geoBoundaries:<shapeID>" - lets the seed upsert, keeping ids stable for gyms.area_id.
    sourceRef: text("source_ref").notNull(),
  },
  (table) => [
    index("areas_geom_gist").using("gist", table.geom),
    index("areas_parent_idx").on(table.parentId),
    uniqueIndex("areas_source_ref_unique").on(table.sourceRef),
    check("areas_level_check", sql`${table.level} IN ('country', 'region', 'county', 'city')`),
  ]
)

// Remapped from Better Auth's own "user" table name via auth.ts's
// modelName option, to keep this app's bigint-id scheme everywhere.
export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    email: text("email").notNull().unique(),
    role: text("role").notNull().default("user"),
    name: text("name").notNull().default(""),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("users_role_check", sql`${table.role} IN ('user', 'admin')`)]
)

// Export name must be exactly "session" - Better Auth looks tables up
// by export identifier, not SQL table name.
export const session = pgTable(
  "session",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
)

export const account = pgTable(
  "account",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // providerId: "credential" | "google" | "facebook" | "apple".
    // accountId: the provider's own id for this account.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Migrated bcrypt hashes land here - Better Auth can verify against
    // bcryptjs directly, so migrated users keep their password.
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    // Lookup key, and what makes the migration's account insert idempotent.
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
  ]
)

export const verification = pgTable(
  "verification",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
)

export const gyms = pgTable(
  "gyms",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    location: point("location").notNull(),
    // Both generated from `location` directly - a generated column can't
    // reference another generated column.
    geohash5: text("geohash5").generatedAlwaysAs(
      (): SQL => sql`ST_GeoHash(${gyms.location}, 5)`
    ),
    geohash4: text("geohash4").generatedAlwaysAs(
      (): SQL => sql`left(ST_GeoHash(${gyms.location}, 5), 4)`
    ),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    // Real columns, not inside `details` - caught live (building the
    // tiles route): API.md's own response shapes show both as top-level
    // fields on every tile/gym-details response (2.2, 2.3), and
    // `description` specifically gets truncated to ~300 chars for tiles,
    // which wants a plain column, not a jsonb extraction. Phase 4's
    // migration script was missing these entirely before this fix - a
    // real silent data-loss bug, not just a schema gap, since nothing
    // downstream ever read gyms.address/description from the old data.
    address: text("address"),
    description: text("description"),
    // ISO 3166-1 alpha-2, from reverse-geocoding at creation. Drives
    // which local currency a USD-stored price displays in.
    countryCode: text("country_code"),
    // Most specific area containing the gym; names are read by walking
    // areas.parent_id, never copied here (LOCATION_NAMES.md).
    areaId: bigint("area_id", { mode: "number" }).references(() => areas.id, { onDelete: "set null" }),
    // Free text - formats vary and many countries have none.
    postcode: text("postcode"),
    acceptsDropIn: boolean("accepts_drop_in"),
    hasTrial: boolean("has_trial"),
    // Opening hours, amenities, website, trial details, etc.
    details: jsonb("details"),
    status: text("status").notNull().default("active"),
    // Stamped whenever an approved "name" field change or a brand-new
    // gym is applied (bot-review.ts's applyProposedChange) - lets the
    // weekly OSM refresh tell "nobody's ever confirmed this" from "an
    // admin/bot already confirmed this, recently" and skip overwriting
    // name/location in the second case. Null means OSM is still
    // authoritative (never confirmed).
    nameLocationDecidedAt: timestamp("name_location_decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("gyms_location_gist").using("gist", table.location),
    index("gyms_geohash4_idx").on(table.geohash4),
    index("gyms_geohash5_idx").on(table.geohash5),
    index("gyms_categories_gin").using("gin", table.categories),
    index("gyms_area_idx").on(table.areaId),
    check("gyms_status_check", sql`${table.status} IN ('active', 'closed', 'hidden')`),
  ]
)

export const gymPrices = pgTable(
  "gym_prices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gymId: bigint("gym_id", { mode: "number" })
      .notNull()
      .references(() => gyms.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Always USD going forward (Decided by Joey, 2026-11-04) - amountMinor
    // equals usdCents; local display is converted at read time (lib.ts).
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    usdCents: integer("usd_cents").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceUrl: text("source_url"),
    // The date a Google Maps menu photo was posted - the fact the
    // verification rule checks is "<1 year old" (STACK_AND_SCHEMA.md 2.6).
    menuPostedOn: date("menu_posted_on"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // null = unverified. Never promoted by the bot - only an admin
    // approving a gym_changes row sets this (STACK_AND_SCHEMA.md 2.6).
    verifiedBy: text("verified_by"),
    isVerified: boolean("is_verified").generatedAlwaysAs(
      (): SQL => sql`${gymPrices.verifiedBy} IS NOT NULL`
    ),
  },
  (table) => [
    // At most one verified + one unverified row per gym per kind; no history.
    uniqueIndex("gym_prices_gym_kind_verified_unique").on(table.gymId, table.kind, table.isVerified),
    check(
      "gym_prices_source_kind_check",
      sql`${table.sourceKind} IN ('gym_website', 'price_menu', 'user', 'review', 'chat', 'sweep_research')`
    ),
    check("gym_prices_verified_by_check", sql`${table.verifiedBy} IN ('bot', 'admin')`),
  ]
)

export const gymSourceRefs = pgTable(
  "gym_source_refs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gymId: bigint("gym_id", { mode: "number" })
      .notNull()
      .references(() => gyms.id, { onDelete: "cascade" }),
    // "osm" | "google_maps" | etc. - open-ended, no schema change per source.
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("gym_source_refs_source_external_unique").on(table.source, table.externalId)]
)

export const requests = pgTable(
  "requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Null for a signed-out sweep (FR-15, FR-22), or a deleted user.
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    failureReason: text("failure_reason"),
    input: jsonb("input"),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("requests_user_id_idx").on(table.userId),
    check("requests_kind_check", sql`${table.kind} IN ('add_gym', 'update_gym', 'sweep')`),
    check("requests_status_check", sql`${table.status} IN ('pending', 'completed', 'failed')`),
  ]
)

export const gymChanges = pgTable(
  "gym_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Null for a chat-found fact - no `requests` row exists for those.
    requestId: bigint("request_id", { mode: "number" }).references(() => requests.id, { onDelete: "cascade" }),
    // Null for a brand-new gym.
    gymId: bigint("gym_id", { mode: "number" }).references(() => gyms.id, { onDelete: "cascade" }),
    proposed: jsonb("proposed").notNull(),
    // What the bot found/matched against, for admin audit.
    evidence: jsonb("evidence"),
    reviewStatus: text("review_status").notNull().default("pending_bot"),
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("gym_changes_request_id_idx").on(table.requestId),
    index("gym_changes_gym_id_idx").on(table.gymId),
    index("gym_changes_review_status_idx").on(table.reviewStatus),
    check(
      "gym_changes_review_status_check",
      sql`${table.reviewStatus} IN ('pending_bot', 'awaiting_admin', 'approved', 'rejected')`
    ),
    check("gym_changes_decided_by_check", sql`${table.decidedBy} IN ('bot', 'admin')`),
  ]
)

// Keyed by (geohash, source) - a new source is new rows, not a schema change.
export const tileFetches = pgTable(
  "tile_fetches",
  {
    geohash: text("geohash").notNull(),
    source: text("source").notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    gymsFound: integer("gyms_found"),
  },
  (table) => [uniqueIndex("tile_fetches_geohash_source_unique").on(table.geohash, table.source)]
)

// Unique on token alone (not per-user) - re-registering the same
// device's token moves/updates the existing row, not a second one.
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("push_tokens_user_id_idx").on(table.userId),
    check("push_tokens_platform_check", sql`${table.platform} IN ('ios', 'android', 'web')`),
  ]
)

// A single-row cache, not a history table - shared across processes,
// unlike the old demo's per-process in-memory fxCache.
export const fxRates = pgTable("fx_rates", {
  id: text("id").primaryKey().default("latest"),
  rates: jsonb("rates").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
})

export const reviews = pgTable(
  "reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gymId: bigint("gym_id", { mode: "number" })
      .notNull()
      .references(() => gyms.id, { onDelete: "cascade" }),
    // Nullable: migrated demo reviews have no user_id. onDelete:
    // "cascade" - deleting a user removes their reviews (unlike
    // requests, which are kept but unlinked).
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, { onDelete: "cascade" }),
    rating: smallint("rating").notNull(),
    body: text("body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Partial unique index, not a plain one - multiple NULL user_ids
    // (every migrated demo review) must NOT collide with each other.
    uniqueIndex("reviews_gym_user_unique").on(table.gymId, table.userId).where(sql`${table.userId} IS NOT NULL`),
    check("reviews_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
  ]
)
