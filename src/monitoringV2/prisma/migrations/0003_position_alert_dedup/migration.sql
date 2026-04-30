-- Per-position alert dedup: timestamps of the last sent alert per watcher
-- so we don't re-alert every cycle.
ALTER TABLE "position_states"
  ADD COLUMN "mini_lifetime_alerted_at"        BIGINT,
  ADD COLUMN "expiring_soon_alerted_at"        BIGINT,
  ADD COLUMN "expired_alerted_at"              BIGINT,
  ADD COLUMN "phase2_alerted_at"               BIGINT,
  ADD COLUMN "suspicious_liq_price_alerted_at" BIGINT;
