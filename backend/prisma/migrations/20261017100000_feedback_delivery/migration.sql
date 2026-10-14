-- Обращения из Основы доходят до облака (batch46).

-- Основа помнит, что отправлено, и повторяет остальное.
ALTER TABLE "Feedback" ADD COLUMN "sentAt" TIMESTAMP(3);
ALTER TABLE "Feedback" ADD COLUMN "sendError" TEXT;

-- Облако: обращения Основ. Таблица платформы, без построчной изоляции —
-- как Box: читает её только владелец платформы.
CREATE TABLE "BoxFeedback" (
    "id" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "boxId" TEXT,
    "kind" "FeedbackKind" NOT NULL,
    "text" TEXT NOT NULL,
    "workshop" TEXT NOT NULL,
    "email" TEXT,
    "version" TEXT,
    "ip" TEXT,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoxFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BoxFeedback_localId_key" ON "BoxFeedback"("localId");
CREATE INDEX "BoxFeedback_handledAt_createdAt_idx" ON "BoxFeedback"("handledAt", "createdAt");

ALTER TABLE "BoxFeedback" ADD CONSTRAINT "BoxFeedback_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE SET NULL ON UPDATE CASCADE;
