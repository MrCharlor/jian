CREATE TABLE epic_drafts (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  pauta_id uuid NOT NULL REFERENCES pautas(id) ON DELETE CASCADE,
  state text NOT NULL,
  request_work_id text,
  title text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  prototype_url text,
  tasks jsonb NOT NULL,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  original jsonb NOT NULL,
  work jsonb NOT NULL,
  error text,
  proposed_by text,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX epic_drafts_pauta ON epic_drafts (pauta_id, created_at DESC);
