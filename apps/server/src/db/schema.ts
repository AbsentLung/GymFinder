// Real schema per STACK_AND_SCHEMA.md part 2. The old apps/server/db/*.sql
// is the vibe-coded demo, kept as reference only.
//
// Better Auth adds its own session/account/verification tables in Phase 5
// - not added here since Phase 3 is schema-only.

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
    // Both generated from `location` directly - a generated column can't
    // reference another generated column.
    geohash5: text("geohash5").generatedAlwaysAs(
      (): SQL => sql`ST_GeoHash(${gyms.location}, 5)`
    ),
    geohash4: text("geohash4").generatedAlwaysAs(
      (): SQL => sql`left(ST_GeoHash(${gyms.location}, 5), 4)`
    ),
    categories: text("categories").array().notNull().default(sql`'{}'::text[]`),
    acceptsDropIn: boolean("accepts_drop_in"),
    hasTrial: boolean("has_trial"),
    // Opening hours, amenities, website, trial details, etc.
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
    // At most one verified + one unverified row per gym per kind; no history.
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
    // Signed-out users can't create a request (FR-15) - only chat is
    // open to them, and a chat never becomes a `requests` row.
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

export const reviews = pgTable(
  "reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gymId: bigint("gym_id", { mode: "number" })
      .notNull()
      .references(() => gyms.id, { onDelete: "cascade" }),
    // Nullable: migrated demo reviews have no user_id.
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
