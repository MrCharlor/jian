CREATE TABLE validations (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  epic_work_id text NOT NULL,
  epic_title text NOT NULL,
  preview_url text,
  prototype_url text,
  pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL,
  items jsonb NOT NULL,
  tasks jsonb NOT NULL,
  notes jsonb NOT NULL,
  state text NOT NULL,
  commented boolean NOT NULL DEFAULT false,
  returns jsonb NOT NULL,
  decided_via text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX validations_epic ON validations (epic_work_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE return_reviews (
  work_id text PRIMARY KEY,
  problems jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
