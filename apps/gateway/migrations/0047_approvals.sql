ALTER TABLE profiles ADD COLUMN action_policy jsonb NOT NULL DEFAULT '{"machine":2,"service":2,"message":2,"tools":{}}'::jsonb;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN owner boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'used', 'expired');
--> statement-breakpoint
CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  number integer NOT NULL,
  tool text NOT NULL,
  action text NOT NULL,
  input jsonb,
  input_hash text NOT NULL,
  summary text NOT NULL DEFAULT '',
  status approval_status NOT NULL,
  decided_at timestamptz,
  decided_via text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX approvals_number ON approvals (profile_id, number);
--> statement-breakpoint
CREATE INDEX approvals_pending ON approvals (profile_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX approvals_session ON approvals (profile_id, session_id, created_at DESC);
