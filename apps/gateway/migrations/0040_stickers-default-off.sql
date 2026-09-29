-- New agents start without sticker analysis; saved choices and legacy switches are preserved.
ALTER TABLE "profiles" ALTER COLUMN "use_stickers" SET DEFAULT false;
--> statement-breakpoint
-- Distinct marker: an older gateway sees an unavailable provider and cannot fall back.
-- To roll back untouched rows, delete this marker and restore use_stickers for sticker rows.
INSERT INTO "model_defaults" ("profile_id", "role", "provider_id", "model_id")
SELECT p."id", r."role", '00000000-0000-0000-0000-000000000000'::uuid, 'disabled_legacy_default'
FROM "profiles" p
CROSS JOIN (VALUES ('image'), ('vision'), ('audio'), ('speech'), ('sticker')) AS r("role")
WHERE NOT EXISTS (
  SELECT 1 FROM "model_defaults" d WHERE d."profile_id" = p."id" AND d."role" = r."role"
) AND (r."role" <> 'sticker' OR p."use_stickers" = true);
--> statement-breakpoint
UPDATE "profiles" p SET "use_stickers" = false
WHERE p."use_stickers" = true AND EXISTS (
  SELECT 1 FROM "model_defaults" d
  WHERE d."profile_id" = p."id" AND d."role" = 'sticker'
    AND d."model_id" = 'disabled_legacy_default'
);
