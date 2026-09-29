ALTER TABLE "work_items" ADD COLUMN "media_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "work_item_id" uuid REFERENCES "work_items"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "subagent" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "subagent_reported_at" timestamptz;
--> statement-breakpoint
CREATE INDEX "runs_work_item" ON "runs" ("profile_id", "work_item_id", "created_at") WHERE "work_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "runs_subagent_spawn" ON "runs" ("profile_id", ("subagent"->>'parentRunId'), ("subagent"->>'spawnKey')) WHERE "subagent" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "runs_unreported_subagent" ON "runs" ("status") WHERE "subagent" IS NOT NULL AND "subagent_reported_at" IS NULL;
