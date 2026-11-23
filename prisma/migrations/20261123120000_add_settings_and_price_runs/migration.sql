-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PriceRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL DEFAULT 'apply',
    "gram24" REAL,
    "usdPerOunce" REAL,
    "usdEgp" REAL,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "changes" TEXT NOT NULL,
    "errors" TEXT,
    "undone" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE INDEX "PriceRun_shop_createdAt_idx" ON "PriceRun"("shop", "createdAt");
