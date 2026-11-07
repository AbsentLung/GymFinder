CREATE TABLE "regions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"geom" geometry(MultiPolygon, 4326) NOT NULL,
	"source_ref" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "region_id" bigint;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "postcode" text;--> statement-breakpoint
CREATE INDEX "regions_geom_gist" ON "regions" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_source_ref_unique" ON "regions" USING btree ("source_ref");--> statement-breakpoint
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gyms_region_idx" ON "gyms" USING btree ("region_id");