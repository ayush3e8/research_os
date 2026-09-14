CREATE TABLE IF NOT EXISTS "live_turn_claims" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"response_text" text,
	"response_tool_calls" jsonb,
	"stop_reason" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
