CREATE TABLE prototypes (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title text NOT NULL,
  request_url text,
  brief text NOT NULL,
  created_by text NOT NULL,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  approved_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX prototypes_application ON prototypes (application_id, updated_at DESC);
--> statement-breakpoint
CREATE TABLE prototype_versions (
  prototype_id uuid NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  number integer NOT NULL,
  status text NOT NULL,
  comments text,
  html text,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (prototype_id, number)
);
--> statement-breakpoint
CREATE INDEX prototype_versions_waiting ON prototype_versions (status, created_at);
--> statement-breakpoint
CREATE TABLE prototype_prints (
  prototype_id uuid NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  name text NOT NULL,
  content_type text NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (prototype_id, name)
);
