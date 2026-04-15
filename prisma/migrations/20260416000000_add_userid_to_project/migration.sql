-- AlterTable
ALTER TABLE "Project" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
