-- AlterTable: columns used by @shopify/shopify-app-session-storage-prisma v11
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT,
ADD COLUMN "refreshTokenExpires" TIMESTAMP(3);
