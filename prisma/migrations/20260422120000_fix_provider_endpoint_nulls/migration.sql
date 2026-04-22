-- Provider.apiEndpoint / modelsEndpoint must be non-null (see schema.prisma).
-- Older rows or manually altered columns may contain NULL, which breaks Prisma reads.

ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "apiEndpoint" TEXT;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "modelsEndpoint" TEXT;

UPDATE "Provider" SET "apiEndpoint" = '' WHERE "apiEndpoint" IS NULL;
UPDATE "Provider" SET "modelsEndpoint" = '' WHERE "modelsEndpoint" IS NULL;

ALTER TABLE "Provider" ALTER COLUMN "apiEndpoint" SET DEFAULT '';
ALTER TABLE "Provider" ALTER COLUMN "apiEndpoint" SET NOT NULL;

ALTER TABLE "Provider" ALTER COLUMN "modelsEndpoint" SET DEFAULT '';
ALTER TABLE "Provider" ALTER COLUMN "modelsEndpoint" SET NOT NULL;
