CREATE TABLE pipelines (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  request_work_id text NOT NULL UNIQUE,
  request_title text NOT NULL,
  stage text NOT NULL,
  pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL,
  needs_prototype boolean,
  prototype_id uuid,
  epic_draft_id uuid REFERENCES epic_drafts(id) ON DELETE SET NULL,
  epic_work_id text,
  rounds integer NOT NULL DEFAULT 0,
  asked text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX pipelines_stage ON pipelines (stage, created_at);
