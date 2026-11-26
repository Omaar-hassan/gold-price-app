-- CreateTable
CREATE TABLE "PriceChange" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "runId" INTEGER,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL DEFAULT '',
    "oldPrice" DOUBLE PRECISION NOT NULL,
    "newPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceChange_shop_variantId_createdAt_idx" ON "PriceChange"("shop", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "PriceChange_shop_createdAt_idx" ON "PriceChange"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_shop_createdAt_idx" ON "AuditLog"("shop", "createdAt");

-- Carry over the price changes already saved inside past runs.
INSERT INTO "PriceChange" ("shop", "runId", "kind", "createdAt", "productId", "variantId", "productTitle", "variantTitle", "oldPrice", "newPrice")
SELECT r."shop", r."id", r."kind", r."createdAt",
       COALESCE(c->>'productId', ''), c->>'variantId', COALESCE(c->>'productTitle', ''), COALESCE(c->>'variantTitle', ''),
       COALESCE((c->>'oldPrice')::double precision, 0), COALESCE((c->>'newPrice')::double precision, 0)
FROM "PriceRun" r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN r."changes" IS NOT NULL AND left(trim(r."changes"), 1) = '[' THEN r."changes"::jsonb ELSE '[]'::jsonb END
) AS c
WHERE c->>'variantId' IS NOT NULL;
