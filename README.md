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

## Deployment

- **Development**: Push to `develop` branch
- **Production**: Push to `main` branch

