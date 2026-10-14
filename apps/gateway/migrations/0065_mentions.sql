CREATE TABLE mentions (
  id uuid PRIMARY KEY,
  number integer NOT NULL UNIQUE,
  comment_id text NOT NULL UNIQUE,
  activity_id text NOT NULL,
  board_id text,
  author_id text NOT NULL,
  author_name text,
  body text NOT NULL,
  card_title text,
  state text NOT NULL,
  kind text,
  high_impact_item integer,
  proposed_reply text,
  published_reply text,
  reason text,
  held_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX mentions_state ON mentions (state, created_at DESC);
