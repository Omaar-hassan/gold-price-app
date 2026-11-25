-- CreateTable
CREATE TABLE "MetalRate" (
    "id" SERIAL NOT NULL,
    "metal" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "usdPerOunce" DOUBLE PRECISION NOT NULL,
    "usdEgp" DOUBLE PRECISION NOT NULL,
    "egpPerGram" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetalRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetalRate_day_idx" ON "MetalRate"("day");

-- CreateIndex
CREATE UNIQUE INDEX "MetalRate_metal_day_key" ON "MetalRate"("metal", "day");

