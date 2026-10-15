CREATE TABLE roadmap_items (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  kind text NOT NULL,
  lane text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  origin text NOT NULL,
  pauta_id uuid REFERENCES pautas(id) ON DELETE SET NULL,
  request_work_id text,
  epic_work_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  theme text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  concluded_at timestamptz
);
--> statement-breakpoint
CREATE INDEX roadmap_items_lane ON roadmap_items (state, lane, position);
--> statement-breakpoint
CREATE TABLE roadmap_proposals (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  kind text NOT NULL,
  item_id uuid REFERENCES roadmap_items(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  counterpoint text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  high_impact boolean NOT NULL DEFAULT false,
  state text NOT NULL,
  proposed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  applied_by text,
  result_id uuid REFERENCES roadmap_items(id) ON DELETE SET NULL,
  note text,
  decided_via text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX roadmap_proposals_state ON roadmap_proposals (state, created_at DESC);
