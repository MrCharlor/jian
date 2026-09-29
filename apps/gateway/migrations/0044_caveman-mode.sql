-- Opt-in per conversation; older gateway binaries ignore this additive column.
ALTER TABLE "sessions" ADD COLUMN "caveman_mode" text NOT NULL DEFAULT 'off'
  CHECK ("caveman_mode" IN ('lite', 'full', 'ultra', 'off'));
