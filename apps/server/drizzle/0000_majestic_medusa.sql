-- Hand-added: drizzle-kit's diff can't express CREATE EXTENSION, so this
-- has to be added to the generated migration by hand (STACK_AND_SCHEMA.md
-- says Drizzle's `sql` escape hatch covers what it can't express directly -
-- this is the migration-file equivalent of that for DDL it never generates
-- at all). postgis: the `geometry` column type and ST_MakePoint/ST_GeoHash
-- functions below need it. pg_trgm: name-similarity dedup matching
-- (STACK_AND_SCHEMA.md 2.11), via the `similarity()` function - same as the
-- vibe-coded demo's schema.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "gym_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" bigint,
	"gym_id" bigint,
	"proposed" jsonb NOT NULL,
	"evidence" jsonb,
	"review_status" text DEFAULT 'pending_bot' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gym_changes_review_status_check" CHECK ("gym_changes"."review_status" IN ('pending_bot', 'awaiting_admin', 'approved', 'rejected')),
	CONSTRAINT "gym_changes_decided_by_check" CHECK ("gym_changes"."decided_by" IN ('bot', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "gym_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"usd_cents" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_url" text,
	"menu_posted_on" date,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by" text,
	"is_verified" boolean GENERATED ALWAYS AS ("gym_prices"."verified_by" IS NOT NULL) STORED,
	CONSTRAINT "gym_prices_source_kind_check" CHECK ("gym_prices"."source_kind" IN ('gym_website', 'price_menu', 'user', 'review', 'chat')),
	CONSTRAINT "gym_prices_verified_by_check" CHECK ("gym_prices"."verified_by" IN ('bot', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "gym_source_refs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gyms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"geohash5" text GENERATED ALWAYS AS (ST_GeoHash("gyms"."location", 5)) STORED,
	"geohash4" text GENERATED ALWAYS AS (left(ST_GeoHash("gyms"."location", 5), 4)) STORED,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"accepts_drop_in" boolean,
	"has_trial" boolean,
	"details" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gyms_status_check" CHECK ("gyms"."status" IN ('active', 'closed', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"failure_reason" text,
	"input" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_kind_check" CHECK ("requests"."kind" IN ('add_gym', 'update_gym', 'sweep')),
	CONSTRAINT "requests_status_check" CHECK ("requests"."status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"user_id" bigint,
	"rating" smallint NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "tile_fetches" (
	"geohash" text NOT NULL,
	"source" text NOT NULL,
	"last_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"gyms_found" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('user', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "gym_changes" ADD CONSTRAINT "gym_changes_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_changes" ADD CONSTRAINT "gym_changes_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_prices" ADD CONSTRAINT "gym_prices_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_source_refs" ADD CONSTRAINT "gym_source_refs_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_changes_request_id_idx" ON "gym_changes" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "gym_changes_gym_id_idx" ON "gym_changes" USING btree ("gym_id");--> statement-breakpoint
CREATE INDEX "gym_changes_review_status_idx" ON "gym_changes" USING btree ("review_status");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_prices_gym_kind_verified_unique" ON "gym_prices" USING btree ("gym_id","kind","is_verified");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_source_refs_source_external_unique" ON "gym_source_refs" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "gyms_location_gist" ON "gyms" USING gist ("location");--> statement-breakpoint
CREATE INDEX "gyms_geohash4_idx" ON "gyms" USING btree ("geohash4");--> statement-breakpoint
CREATE INDEX "gyms_geohash5_idx" ON "gyms" USING btree ("geohash5");--> statement-breakpoint
CREATE INDEX "gyms_categories_gin" ON "gyms" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "requests_user_id_idx" ON "requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_gym_user_unique" ON "reviews" USING btree ("gym_id","user_id") WHERE "reviews"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tile_fetches_geohash_source_unique" ON "tile_fetches" USING btree ("geohash","source");