ALTER TABLE runs ADD COLUMN origin text;
--> statement-breakpoint
CREATE TYPE correction_kind AS ENUM ('rejected', 'edited', 'redone');
--> statement-breakpoint
CREATE TABLE corrections (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  automation text NOT NULL,
  kind correction_kind NOT NULL,
  original jsonb,
  corrected jsonb,
  note text,
  via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX corrections_automation ON corrections (profile_id, automation, created_at DESC);
--> statement-breakpoint
CREATE INDEX corrections_recent ON corrections (profile_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX runs_origin ON runs (profile_id, origin, created_at DESC) WHERE origin IS NOT NULL;
