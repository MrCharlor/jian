ALTER TABLE plans ADD COLUMN priority_proposal_id uuid REFERENCES priority_proposals(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX plans_priority ON plans (priority_proposal_id);
