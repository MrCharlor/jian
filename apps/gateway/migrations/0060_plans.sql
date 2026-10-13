CREATE TABLE plans (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  action text NOT NULL,
  prototype_id uuid REFERENCES prototypes(id) ON DELETE SET NULL,
  prototype_version integer,
  pauta_id uuid,
  author_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  author_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  reviewer_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  original text,
  revised text,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  rounds integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  note text,
  approved_by text,
  decided_via text,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX plans_state ON plans (state, updated_at DESC);
--> statement-breakpoint
CREATE INDEX plans_prototype ON plans (prototype_id, prototype_version);
