CREATE TABLE screens (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  route text NOT NULL,
  menu_path text NOT NULL DEFAULT '',
  title text NOT NULL,
  squad text,
  state text NOT NULL,
  sheet jsonb,
  work_url text,
  mapped_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX screens_route ON screens (application_id, route);
--> statement-breakpoint
CREATE INDEX screens_state ON screens (application_id, state);
--> statement-breakpoint
CREATE TABLE screen_prints (
  screen_id uuid NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  name text NOT NULL,
  content_type text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screen_id, name)
);
