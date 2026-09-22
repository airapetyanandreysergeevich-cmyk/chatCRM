-- История ремонта: сообщения мастеров в карточке заказа и фото к ним.

ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'MESSAGE';

CREATE TABLE "OrderMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrderMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderMessage_tenantId_orderId_createdAt_idx" ON "OrderMessage"("tenantId", "orderId", "createdAt");

ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderMessage" ADD CONSTRAINT "OrderMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Attachment" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "OrderMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Изоляция мастерских — здесь же, как у QuickPick: rls.sql применяется
-- отдельной командой, и таблица не должна жить без политики до её запуска.
ALTER TABLE "OrderMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderMessage";
CREATE POLICY tenant_isolation ON "OrderMessage"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
