CREATE TABLE "fx_rates" (
	"id" text PRIMARY KEY DEFAULT 'latest' NOT NULL,
	"rates" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
