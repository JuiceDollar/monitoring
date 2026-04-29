-- Add escalation flags for the auction-deadline watchdog (T-24h / T-2h).
ALTER TABLE "public"."challenge_states"
	ADD COLUMN IF NOT EXISTS "t24_alerted" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "public"."challenge_states"
	ADD COLUMN IF NOT EXISTS "t2_alerted" BOOLEAN NOT NULL DEFAULT FALSE;
