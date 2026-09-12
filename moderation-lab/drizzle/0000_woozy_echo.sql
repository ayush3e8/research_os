CREATE TABLE "architecture_agents" (
	"architecture" text PRIMARY KEY NOT NULL,
	"elevenlabs_agent_id" text NOT NULL,
	"is_custom_llm" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_state" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"architecture" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"axis_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_profile" text NOT NULL,
	"system_prompt" text NOT NULL,
	"elevenlabs_voice_id" text,
	"elevenlabs_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_claims" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"response_text" text,
	"response_tool_calls" jsonb,
	"stop_reason" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"architecture" text NOT NULL,
	"call_type" text DEFAULT 'moderator' NOT NULL,
	"conversation_fingerprint" text,
	"model" text NOT NULL,
	"request_system" text NOT NULL,
	"request_messages" jsonb NOT NULL,
	"request_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_request_body" jsonb NOT NULL,
	"response_text" text,
	"response_tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_reason" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
