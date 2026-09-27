-- What the decisions service cost, per UTC day and use: counts only, never what was asked.
CREATE TABLE "decision_usage" (
	"day" text NOT NULL,
	"use" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"cached" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "decision_usage_day_use_pk" PRIMARY KEY("day","use")
);
