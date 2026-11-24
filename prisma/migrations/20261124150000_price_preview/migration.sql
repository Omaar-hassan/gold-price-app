-- CreateTable
CREATE TABLE "PricePreview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gram24" DOUBLE PRECISION,
    "usdPerOunce" DOUBLE PRECISION,
    "usdEgp" DOUBLE PRECISION,
    "rows" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "PricePreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricePreview_shop_createdAt_idx" ON "PricePreview"("shop", "createdAt");

