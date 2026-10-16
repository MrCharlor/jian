CREATE TABLE request_drafts (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  pauta_id uuid NOT NULL REFERENCES pautas(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  work_id text,
  proposed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
