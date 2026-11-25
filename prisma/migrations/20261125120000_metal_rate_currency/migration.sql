-- Rate history per store currency. Existing rows are EGP.
ALTER TABLE "MetalRate" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EGP';

DROP INDEX "MetalRate_metal_day_key";

CREATE UNIQUE INDEX "MetalRate_metal_day_currency_key" ON "MetalRate"("metal", "day", "currency");
