ALTER TABLE "work_items" ADD COLUMN "repositories" jsonb NOT NULL DEFAULT '[]'::jsonb;
