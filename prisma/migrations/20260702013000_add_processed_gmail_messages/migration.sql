-- CreateTable
CREATE TABLE "processed_gmail_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "account_email" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_gmail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_gmail_messages_message_id_key" ON "processed_gmail_messages"("message_id");
