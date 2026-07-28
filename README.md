# JuiceDollar (JUSD) Protocol Monitoring

Real-time monitoring service for the JuiceDollar protocol on Citrea blockchain (chain ID 4114).

Forked from [dEURO monitoring](https://github.com/d-EURO/monitoring) and adapted for the JUSD protocol.

## Architecture

The monitoring service continuously syncs blockchain data to provide real-time insights:

1. **Event Collection**: Fetches all protocol events (PositionOpened, MinterApplied, ChallengeStarted, etc.) from blockchain logs
2. **Dynamic Discovery**: Automatically detects new positions, minters, and bridges as they're created on-chain
3. **State Tracking**: Maintains current state for:
   - Positions (collateral, debt, status, cooldowns)
   - Challenges (active auctions, liquidations)
   - Minters (generic minters and bridge contracts)
   - Collateral aggregation by token type
4. **Token Prices**: Fetches real-time prices from GeckoTerminal API with caching
5. **API Endpoints**: Serves data via REST API for frontend consumption
6. **Minter Guard**: Optional auto-deny watcher (opt-in via `GUARD_ENABLED=true`). At the end of every monitoring cycle it submits `denyMinter()` for any `PROPOSED` minter not on the committed whitelist (`src/monitoringV2/config/whitelist.mainnet.json`), bridges included. `denyMinter` is a shareholder veto (not an admin call): the signer needs ≥2% of Equity voting power (`Equity.checkQualified`), alone or via delegators, within the finite application window from `suggestMinter`. The guard verifies qualification and gas before sending (skips loudly and rate-limits those pages instead of submitting a doomed tx). Helpers are derived from indexed `Delegation` events; `GUARD_HELPER_ADDRESS` is an optional static seed for a named helper independent of the indexer. Permanently rejected denies (expired application period) stop retrying; other failures stop after a bounded attempt count with a single escalation. Live status is at `GET /guard` and rendered as the dashboard "Guard Delegation" section (where shareholders can delegate). An empty whitelist is deny-by-default and logged as a warning. See `.env.example`.

## Tech Stack

- **Backend**: NestJS
- **ORM**: Prisma
- **Database**: PostgreSQL
- **API Port**: 3001

## Local Development

### Prerequisites
- Node.js 18+
- PostgreSQL database
- Citrea RPC endpoint

### Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings:
# - DATABASE_URL: PostgreSQL connection string
# - RPC_URL: https://rpc.citreascan.com (Citrea mainnet)
# - BLOCKCHAIN_ID: Must be 4114 (Citrea)
# - COINGECKO_BASE_URL: required, see "CoinGecko" section below

# Generate Prisma client
npm run prisma:generate

# Run database migrations
node src/monitoringV2/prisma/migrate.js

# Start the service
npm run build
npm run start:prod
```

## Docker

```bash
# Build the image
docker build -t jusd-monitoring:test .

# Run with your .env file
docker run --name jusd-test -p 3001:3001 --env-file .env jusd-monitoring:test

# Test the API
curl http://localhost:3001/health

# Clean up
docker rm -f jusd-test
```

## API Documentation

Swagger documentation available at: `http://localhost:3001/swagger`

### Key Endpoints

| Endpoint | Description |
|---|---|
| `/health` | Service health check |
| `/positions` | Active collateral positions |
| `/challenges` | Active position challenges |
| `/collateral` | Supported collateral tokens |
| `/jusd` | JUSD supply and protocol stats |
| `/minters` | Registered minters |
| `/guard` | Minter-guard live status |

## CoinGecko

The monitoring service needs a CoinGecko-compatible endpoint for BTC spot
prices — they drive the WCBTC suspicious-liq-price watchdog. Configuration
is two env vars:

| Var | Required | Purpose |
|---|---|---|
| `COINGECKO_BASE_URL` | yes | Origin the service calls. |
| `COINGECKO_API_KEY` | no | Attached as the `x-cg-pro-api-key` header on every request when set. |

The recommended deployment is the
[**pricing-proxy**](https://github.com/DFXswiss/pricing-proxy) — a small
caching reverse-proxy in front of CoinGecko Pro. It holds the upstream key,
serves a 60 s shared cache, validates upstream error envelopes, and
coalesces concurrent identical requests. When you use the proxy:

```env
COINGECKO_BASE_URL=http://pricing-proxy:8080/coingecko
# COINGECKO_API_KEY left unset — the proxy injects its own key
```

Without the proxy you can talk to CoinGecko directly:

```env
COINGECKO_BASE_URL=https://pro-api.coingecko.com
COINGECKO_API_KEY=CG-xxxxxxxxxxxxxxxxxxxxxxxx
```

The service refuses to start without `COINGECKO_BASE_URL`.

## Deployment

- **Development**: Push to `develop` branch
- **Production**: Push to `main` branch



