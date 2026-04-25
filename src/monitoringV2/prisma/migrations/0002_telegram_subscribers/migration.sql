-- Telegram alert subscribers — populated via /start command on the bot
-- Idempotent: safe to run on fresh or existing databases

CREATE TABLE IF NOT EXISTS "public"."telegram_subscribers" (
    "chat_id" VARCHAR(32) NOT NULL,
    "username" VARCHAR(64),
    "first_name" VARCHAR(128),
    "last_name" VARCHAR(128),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_subscribers_pkey" PRIMARY KEY ("chat_id")
);

CREATE INDEX IF NOT EXISTS "idx_telegram_subscribers_active" ON "public"."telegram_subscribers"("active");

-- Singleton row tracking the last processed Telegram update_id for long-polling
CREATE TABLE IF NOT EXISTS "public"."telegram_poll_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_update_id" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "telegram_poll_state_pkey" PRIMARY KEY ("id")
);

INSERT INTO "public"."telegram_poll_state" ("id", "last_update_id")
VALUES (1, 0)
ON CONFLICT ("id") DO NOTHING;
