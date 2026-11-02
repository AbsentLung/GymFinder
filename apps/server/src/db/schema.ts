// Gym Finder's real schema, per STACK_AND_SCHEMA.md part 2 (PR #6/#9's
// decisions). The old apps/server/db/*.sql and apps/server/server/*.js
// are the vibe-coded demo kept as REFERENCE ONLY (per the restructure
// plan) - this file is the actual schema going forward, migrated via
// drizzle-kit (see drizzle.config.ts). The one-off migration script in
// Phase 4 reads the old schema and writes into tables defined here.
//
// Better Auth will add its own `session`, `account` and `verification`
// tables alongside `users` in Phase 5 (and likely a few more columns on
// `users` itself, e.g. emailVerified/name/image) - STACK_AND_SCHEMA.md
// 2.2 says as much ("they're not shown" in its ER diagram). Not added
// here since Phase 3 is schema-only and Better Auth's own CLI generates
// that part when auth is actually wired up.

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
} from "drizzle-orm/pg-core"

// --- PostGIS geometry(Point, 4326) -----------------------------------
// Drizzle's pg-core has no built-in PostGIS type (confirmed against the
// current docs, not memory, per AGENTS.md's instruction) - this is the
// documented customType escape hatch. toDriver writes via ST_MakePoint
// (always produces a valid point, no WKT-parsing risk on the way in).
// fromDriver is intentionally a pass-through: node-postgres returns
// geometry columns as hex-encoded EWKB over the wire, not the {lat,lng}
// shape this type claims, unless the query explicitly selects
// ST_X(location)/ST_Y(location) (or ST_AsGeoJSON) instead of the raw
// column. No application code queries this yet (that's Phase 5), so
// there's nothing depending on automatic deserialization working today
// - flagged here rather than shipping a parser for a shape nothing
// reads yet.
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

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    email: text("email").notNull().unique(),
    role: text("role").notNull().default("user"),
  },
  (table) => [check("users_role_check", sql`${table.role} IN ('user', 'admin')`)]
)

export const gyms = pgTable(
  "gyms",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    location: point("location").notNull(),
    // Generated from `location` directly, not from each other - Postgres
    // (and Drizzle) generated columns can't reference another generated
    // column, so geohash4 re-states "the first 4 chars of the geohash5
    // expression" rather than reading the geohash5 column.
    geohash5: text("geohash5").generatedAlwaysAs(
      (): SQL => sql`ST_GeoHash(${gyms.location}, 5)`
    ),
    geohash4: text("geohash4").generatedAlwaysAs(
      (): SQL => sql`left(ST_GeoHash(${gyms.location}, 5), 4)`
    ),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    acceptsDropIn: boolean("accepts_drop_in"),
    hasTrial: boolean("has_trial"),
    // Hybrid per STACK_AND_SCHEMA.md 2.7: opening hours (OSM
    // `opening_hours` format), amenities, website, trial details, etc.
    details: jsonb("details"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("gyms_location_gist").using("gist", table.location),
    index("gyms_geohash4_idx").on(table.geohash4),
    index("gyms_geohash5_idx").on(table.geohash5),
    index("gyms_categories_gin").using("gin", table.categories),
    // pg_trgm similarity on name, for dedup (STACK_AND_SCHEMA.md 2.11) -
    // the operator class itself (gin_trgm_ops) needs pg_trgm, added in
    // the migration's raw-SQL section below since Drizzle has no typed
    // helper for a non-default opclass.
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
    // "At most two current rows per gym per kind: one verified and one
    // unverified" (STACK_AND_SCHEMA.md 2.6) - no history, a newer price
    // of the same kind+status replaces the old one via upsert.
    uniqueIndex("gym_prices_gym_kind_verified_unique").on(table.gymId, table.kind, table.isVerified),
    check(
      "gym_prices_source_kind_check",
      sql`${table.sourceKind} IN ('gym_website', 'price_menu', 'user', 'review', 'chat')`
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
    // "osm | google_maps | places | foursquare", open-ended on purpose -
    // OOS-1's regional sources (Yandex, Baidu) are just new values here,
    // no schema change (STACK_AND_SCHEMA.md 2.11).
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
    // Signed-out users never create a request (FR-15: submitting or
    // requesting changes needs an account; browsing doesn't) - chats are
    // the one thing a signed-out user can trigger, and chats never
    // become `requests` rows at all (API.md 1.4).
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
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
    // Null for a chat-found fact - chats never create a `requests` row
    // at all (API.md 1.4), so there's nothing to point this at.
    requestId: bigint("request_id", { mode: "number" }).references(() => requests.id, { onDelete: "cascade" }),
    // Null for a brand-new gym (nothing exists yet to point at).
    gymId: bigint("gym_id", { mode: "number" }).references(() => gyms.id, { onDelete: "cascade" }),
    proposed: jsonb("proposed").notNull(),
    // { sourceKind, url, menuPostedOn, matchedAgainst, ... } - what the
    // bot found and matched against, for admin audit (STACK_AND_SCHEMA.md
    // 2.1, 2.10).
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

// Keyed by (geohash, source) per STACK_AND_SCHEMA.md 2.5's recommendation
// - adding a source (Foursquare, a regional one from OOS-1) is new rows,
// not a schema change. No standalone `tiles` table: the doc's own
// recommendation says one only exists if per-tile extras are needed
// later, which nothing requires yet.
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

export const reviews = pgTable(
  "reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gymId: bigint("gym_id", { mode: "number" })
      .notNull()
      .references(() => gyms.id, { onDelete: "cascade" }),
    // Nullable: demo reviews migrate in without a user_id (Phase 4,
    // STACK_AND_SCHEMA.md 2.14 - "Demo reviews come along with user_id
    // left empty"). The one-per-user-per-gym rule below only applies
    // once a review actually has a user attached.
    userId: bigint("user_id", { mode: "number" }).references(() => users.id),
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
