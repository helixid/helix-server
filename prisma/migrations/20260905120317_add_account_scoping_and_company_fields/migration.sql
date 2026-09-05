-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "fieldOfOperation" TEXT;

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "enrollment_tokens" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "vcs" ADD COLUMN     "accountId" TEXT;

-- CreateIndex
CREATE INDEX "audit_log_accountId_idx" ON "audit_log"("accountId");

-- CreateIndex
CREATE INDEX "enrollment_tokens_accountId_idx" ON "enrollment_tokens"("accountId");

-- CreateIndex
CREATE INDEX "vcs_accountId_idx" ON "vcs"("accountId");
