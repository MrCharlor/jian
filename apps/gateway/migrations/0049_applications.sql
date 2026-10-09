CREATE TABLE applications (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  url text,
  audience text,
  platform text NOT NULL DEFAULT 'web',
  source text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE application_files (
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  path text NOT NULL,
  content_type text NOT NULL,
  encoding text NOT NULL,
  content text NOT NULL,
  bytes integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, path)
);
