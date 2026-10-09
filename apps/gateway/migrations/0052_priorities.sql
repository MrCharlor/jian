CREATE TABLE priority_criteria (
  id text PRIMARY KEY,
  text text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE priority_proposals (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  state text NOT NULL,
  workspace_id text NOT NULL,
  board_id text NOT NULL,
  status_id text NOT NULL,
  source_status_id text,
  server text,
  summary text NOT NULL,
  cards jsonb NOT NULL,
  current jsonb NOT NULL,
  applied jsonb,
  adjusted boolean,
  error text,
  note text,
  proposed_by text,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  decided_via text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX priority_proposals_recent ON priority_proposals (created_at DESC);
