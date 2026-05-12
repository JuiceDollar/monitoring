import { useApi } from './lib/api.hook';
import { SystemOverview } from './components/SystemOverview';
import { PositionsTable } from './components/PositionsTable';
import { CollateralTable } from './components/CollateralTable';
import { ChallengesTable } from './components/ChallengesTable';
import { BridgesTable } from './components/BridgesTable';
import { MintersTable } from './components/MintersTable';
import { HealthStatus } from './components/HealthStatus';
import { Footer } from './components/Footer';

function App() {
	const { health, jusd, positions, collateral, challenges, minters } = useApi();

	return (
		<div className="min-h-screen bg-neutral-950 text-gray-100 flex flex-col">
			<div className="flex-1 max-w-7xl w-full mx-auto p-4 space-y-6 text-sm">
				<HealthStatus {...health} />
				<SystemOverview {...jusd} minters={minters} />
				<PositionsTable data={positions} />
				<CollateralTable {...collateral} />
				<ChallengesTable data={challenges} />
				<BridgesTable data={minters} />
				<MintersTable data={minters} />
			</div>
			<Footer />
		</div>
	);
}

export default App;
