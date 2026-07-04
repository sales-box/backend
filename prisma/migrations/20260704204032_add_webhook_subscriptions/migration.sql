-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connected_account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GMAIL',
    "expiration_date" TIMESTAMPTZ(6) NOT NULL,
    "subscription_id" TEXT,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_connected_account_id_key" ON "webhook_subscriptions"("connected_account_id");

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "connected_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
