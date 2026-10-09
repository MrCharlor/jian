CREATE TABLE pautas (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  state text NOT NULL,
  priority text NOT NULL,
  context text NOT NULL DEFAULT '',
  screens jsonb NOT NULL DEFAULT '[]'::jsonb,
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_steps text NOT NULL DEFAULT '',
  waiting_on text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX pautas_recent ON pautas (updated_at DESC);
--> statement-breakpoint
CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  pauta_id uuid NOT NULL REFERENCES pautas(id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL,
  counterpoint text NOT NULL,
  recommendation text NOT NULL,
  state text NOT NULL,
  choice text,
  reason text,
  decided_via text,
  decided_at timestamptz,
  replaces integer,
  proposed_by text,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX decisions_pauta ON decisions (pauta_id, number);
--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE prototypes ADD COLUMN pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL;
