CREATE TABLE drawings (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  url text NOT NULL,
  pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL,
  room_id text,
  room_key text,
  spec jsonb,
  created_by text,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX drawings_recent ON drawings (updated_at DESC);
