CREATE TABLE IF NOT EXISTS "live_directive_cache" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"recent_summary" text NOT NULL,
	"directive" text NOT NULL,
	"computed_through_message_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
