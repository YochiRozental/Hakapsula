-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cardExpiry" TEXT,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "lastName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_idNumber_key" ON "User"("idNumber");
