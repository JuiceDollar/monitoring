# JuiceDollar (JUSD) Protocol Monitor Frontend

Monitoring dashboard for the JuiceDollar protocol.

## Run it
```bash
npm install

# adjust VITE_API_BASE_URL in .env as needed (see .env.example), then
npm run dev
```

## Components
- **SystemOverview** - Protocol stats at a glance
- **PositionsTable** - Active collateral positions
- **MintersTable** - Minter equity & voting power
- **ChallengesTable** - Active position challenges
- **CollateralTable** - Supported collateral tokens

Data refreshes every minute.
