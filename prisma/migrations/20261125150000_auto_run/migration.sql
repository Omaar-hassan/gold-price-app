-- CreateTable
CREATE TABLE "AutoRun" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "slot" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'running',
    "message" TEXT,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "heldCount" INTEGER NOT NULL DEFAULT 0,
    "runId" INTEGER,

    CONSTRAINT "AutoRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoRun_shop_slot_key" ON "AutoRun"("shop", "slot");

-- CreateIndex
CREATE INDEX "AutoRun_shop_createdAt_idx" ON "AutoRun"("shop", "createdAt");
