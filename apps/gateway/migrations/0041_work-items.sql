CREATE TABLE "work_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "source_session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "status" text NOT NULL DEFAULT 'todo',
  "note" text NOT NULL DEFAULT '',
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "work_items_status" CHECK ("status" IN ('todo','in_progress','review','blocked','done')),
  CONSTRAINT "work_items_version" CHECK ("version" > 0),
  CONSTRAINT "work_items_updated_by" CHECK ("updated_by" IN ('agent','owner'))
);
--> statement-breakpoint
CREATE INDEX "work_items_profile_status" ON "work_items" ("profile_id", "status", "updated_at" DESC);
