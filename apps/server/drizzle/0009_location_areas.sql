CREATE TABLE "areas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"parent_id" bigint,
	"country_code" text NOT NULL,
	"geom" geometry(MultiPolygon, 4326) NOT NULL,
	"source_ref" text NOT NULL,
	CONSTRAINT "areas_level_check" CHECK ("areas"."level" IN ('country', 'region', 'county', 'city'))
);
--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "area_id" bigint;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "postcode" text;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_parent_id_areas_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "areas_geom_gist" ON "areas" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "areas_parent_idx" ON "areas" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_source_ref_unique" ON "areas" USING btree ("source_ref");--> statement-breakpoint
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gyms_area_idx" ON "gyms" USING btree ("area_id");