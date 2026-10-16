CREATE TABLE inbox (
  number integer PRIMARY KEY,
  kind text NOT NULL,
  ref_id text NOT NULL,
  ref_number integer NOT NULL,
  title text NOT NULL,
  high_impact boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  announced_at timestamptz,
  closed_at timestamptz,
  decided_via text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX inbox_ref ON inbox (kind, ref_id);
--> statement-breakpoint
CREATE INDEX inbox_open ON inbox (closed_at, opened_at);
