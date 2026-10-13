CREATE TABLE knowledge (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  code text UNIQUE,
  text text NOT NULL,
  scope jsonb NOT NULL,
  source jsonb NOT NULL,
  sensitive boolean NOT NULL DEFAULT false,
  state text NOT NULL,
  replaces integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX knowledge_state ON knowledge (state);
--> statement-breakpoint
CREATE TABLE knowledge_proposals (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  kind text NOT NULL,
  rule_id uuid REFERENCES knowledge(id) ON DELETE SET NULL,
  rule_text text,
  text text,
  scope jsonb,
  sensitive boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  source jsonb NOT NULL,
  state text NOT NULL,
  proposed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  applied_by text,
  result_id uuid REFERENCES knowledge(id) ON DELETE SET NULL,
  note text,
  decided_via text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX knowledge_proposals_state ON knowledge_proposals (state, created_at DESC);
--> statement-breakpoint
ALTER TABLE plans ADD COLUMN questions jsonb;
