-- AlterTable
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Project_userId_idx" ON "Project"("userId");
