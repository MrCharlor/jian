-- Existing conversations keep Ponytail's default. Rolling back the gateway binary is safe:
-- older versions ignore this column, which must not be dropped while modes are in use.
ALTER TABLE "sessions" ADD COLUMN "ponytail_mode" text NOT NULL DEFAULT 'full'
  CHECK ("ponytail_mode" IN ('lite', 'full', 'ultra', 'off'));
