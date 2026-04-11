-- Baseline migration for JUSD Protocol Monitoring
-- Idempotent: safe to run on fresh or existing databases

-- Raw blockchain events
CREATE TABLE IF NOT EXISTS "public"."raw_events" (
    "block_number" BIGINT NOT NULL,
    "tx_hash" VARCHAR(66) NOT NULL,
    "log_index" INTEGER NOT NULL,
    "contract_address" VARCHAR(42) NOT NULL,
    "topic" VARCHAR(100) NOT NULL,
    "args" JSONB NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "alerted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "raw_events_pkey" PRIMARY KEY ("tx_hash","log_index")
);

CREATE INDEX IF NOT EXISTS "idx_events_block" ON "public"."raw_events"("block_number" DESC);
CREATE INDEX IF NOT EXISTS "idx_events_name_time" ON "public"."raw_events"("topic", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_events_contract" ON "public"."raw_events"("contract_address", "block_number" DESC);
CREATE INDEX IF NOT EXISTS "idx_events_timestamp" ON "public"."raw_events"("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_events_alert" ON "public"."raw_events"("alerted", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_events_data" ON "public"."raw_events" USING GIN("args");

-- Sync state
CREATE TABLE IF NOT EXISTS "public"."sync_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_processed_block" BIGINT,
    "last_completed_block" BIGINT,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "single_row" CHECK ("id" = 1)
);

-- Contract registry
CREATE TABLE IF NOT EXISTS "public"."contracts" (
    "address" VARCHAR(42) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "metadata" JSONB,
    "timestamp" BIGINT NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("address")
);

CREATE INDEX IF NOT EXISTS "idx_contracts_type" ON "public"."contracts"("type");
CREATE INDEX IF NOT EXISTS "idx_contracts_metadata" ON "public"."contracts" USING GIN("metadata");

-- Token registry
CREATE TABLE IF NOT EXISTS "public"."tokens" (
    "address" VARCHAR(42) NOT NULL,
    "symbol" VARCHAR(20),
    "name" VARCHAR(100),
    "decimals" INTEGER,
    "price" DECIMAL(20,8),
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("address")
);

CREATE INDEX IF NOT EXISTS "idx_tokens_symbol" ON "public"."tokens"("symbol");

-- Position states
CREATE TABLE IF NOT EXISTS "public"."position_states" (
    "address" VARCHAR(42) NOT NULL,
    "limit" DECIMAL(78,0) NOT NULL,
    "owner" VARCHAR(42) NOT NULL,
    "original" VARCHAR(42) NOT NULL,
    "collateral" VARCHAR(42) NOT NULL,
    "minimum_collateral" DECIMAL(78,0) NOT NULL,
    "risk_premium_ppm" INTEGER NOT NULL,
    "reserve_contribution" INTEGER NOT NULL,
    "challenge_period" BIGINT NOT NULL,
    "start_timestamp" BIGINT NOT NULL,
    "expiration" BIGINT NOT NULL,
    "created" BIGINT NOT NULL,
    "price" DECIMAL(78,0) NOT NULL,
    "virtual_price" DECIMAL(78,0) NOT NULL,
    "collateral_amount" DECIMAL(78,0) NOT NULL,
    "expired_purchase_price" DECIMAL(78,0) NOT NULL,
    "collateral_requirement" DECIMAL(78,0) NOT NULL,
    "principal" DECIMAL(78,0) NOT NULL,
    "interest" DECIMAL(78,0) NOT NULL,
    "debt" DECIMAL(78,0) NOT NULL,
    "fixed_annual_rate_ppm" INTEGER NOT NULL,
    "last_accrual" BIGINT NOT NULL,
    "cooldown" BIGINT NOT NULL,
    "challenged_amount" DECIMAL(78,0) NOT NULL,
    "available_for_minting" DECIMAL(78,0) NOT NULL,
    "available_for_clones" DECIMAL(78,0) NOT NULL,
    "is_closed" BOOLEAN NOT NULL,
    "is_denied" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "position_states_pkey" PRIMARY KEY ("address")
);

CREATE INDEX IF NOT EXISTS "idx_position_states_owner" ON "public"."position_states"("owner");
CREATE INDEX IF NOT EXISTS "idx_position_states_original" ON "public"."position_states"("original");
CREATE INDEX IF NOT EXISTS "idx_position_states_collateral" ON "public"."position_states"("collateral");
CREATE INDEX IF NOT EXISTS "idx_position_states_is_closed" ON "public"."position_states"("is_closed");

-- Challenge states (composite PK: challenge_id + hub_address)
CREATE TABLE IF NOT EXISTS "public"."challenge_states" (
    "challenge_id" INTEGER NOT NULL,
    "hub_address" VARCHAR(42) NOT NULL,
    "challenger_address" VARCHAR(42) NOT NULL,
    "position_address" VARCHAR(42) NOT NULL,
    "start_timestamp" BIGINT NOT NULL,
    "initial_size" DECIMAL(78,0) NOT NULL,
    "size" DECIMAL(78,0) NOT NULL,
    "current_price" DECIMAL(78,0) NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "challenge_states_pkey" PRIMARY KEY ("challenge_id","hub_address")
);

CREATE INDEX IF NOT EXISTS "idx_challenge_states_position" ON "public"."challenge_states"("position_address");
CREATE INDEX IF NOT EXISTS "idx_challenge_states_challenger" ON "public"."challenge_states"("challenger_address");

-- Collateral states
CREATE TABLE IF NOT EXISTS "public"."collateral_states" (
    "token_address" VARCHAR(42) NOT NULL,
    "total_collateral" DECIMAL(78,0) NOT NULL,
    "position_count" INTEGER NOT NULL,
    "total_limit" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "total_available_for_minting" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "collateral_states_pkey" PRIMARY KEY ("token_address")
);

-- Minter states
CREATE TABLE IF NOT EXISTS "public"."minter_states" (
    "address" VARCHAR(42) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "application_timestamp" BIGINT NOT NULL,
    "application_period" BIGINT NOT NULL,
    "application_fee" DECIMAL(78,0) NOT NULL,
    "message" TEXT,
    "bridge_token" VARCHAR(42),
    "bridge_horizon" BIGINT,
    "bridge_limit" DECIMAL(78,0),
    "status" VARCHAR(20) NOT NULL,
    "bridge_minted" DECIMAL(78,0),
    "timestamp" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "minter_states_pkey" PRIMARY KEY ("address")
);

CREATE INDEX IF NOT EXISTS "idx_minter_states_type" ON "public"."minter_states"("type");
CREATE INDEX IF NOT EXISTS "idx_minter_states_status" ON "public"."minter_states"("status");
CREATE INDEX IF NOT EXISTS "idx_minter_states_bridge_token" ON "public"."minter_states"("bridge_token") WHERE "bridge_token" IS NOT NULL;

-- JUSD system state (single row)
CREATE TABLE IF NOT EXISTS "public"."jusd_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "jusd_total_supply" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "juice_total_supply" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "equity_shares" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "equity_price" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "reserve_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "reserve_minter" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "reserve_equity" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "savings_total" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "savings_interest_collected" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "savings_rate" INTEGER NOT NULL DEFAULT 0,
    "jusd_loss" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "jusd_profit" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "jusd_profit_distributed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "frontend_fees_collected" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "frontends_active" INTEGER NOT NULL DEFAULT 0,
    "savings_interest_collected_24h" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "savings_added_24h" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "savings_withdrawn_24h" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "equity_trade_volume_24h" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "equity_trade_count_24h" INTEGER NOT NULL DEFAULT 0,
    "equity_delegations_24h" INTEGER NOT NULL DEFAULT 0,
    "block_number" BIGINT NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jusd_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_single_row" CHECK ("id" = 1)
);
