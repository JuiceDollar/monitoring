import type { JusdState, MinterResponse } from '../../../shared/types';
import { MinterStatus, MinterType } from '../../../shared/types';
import { colors, spacing } from '../lib/theme';
import { formatNumber, formatPercent } from '../lib/formatters';
import type { DataState } from '../lib/api.hook';

interface SystemOverviewProps extends DataState<JusdState> {
	minters?: DataState<MinterResponse[]>;
}

export function SystemOverview({ data, error, minters }: SystemOverviewProps) {
	if (error) return <div className={colors.critical}>{error}</div>;
	if (!data) return null;

	const jusdProfit = parseFloat(data.jusdProfit);
	const netProfit = jusdProfit - parseFloat(data.jusdLoss);

	const bridges = minters?.data?.filter((m) => m.type === MinterType.BRIDGE && m.status !== MinterStatus.DENIED) || [];
	const activeBridges = bridges.filter((b) => b.status === MinterStatus.APPROVED);
	const bridgeTotalMinted = bridges.reduce((sum, b) => sum + (b.bridgeMinted ? Number(b.bridgeMinted) : 0), 0);
	const bridgeTotalLimit = bridges.reduce((sum, b) => sum + (b.bridgeLimit ? Number(b.bridgeLimit) : 0), 0);
	const bridgeUtilization = bridgeTotalLimit > 0 ? (bridgeTotalMinted * 100) / bridgeTotalLimit : 0;

	return (
		<div className={`${colors.background} ${colors.table.border} border rounded-xl p-4`}>
			<h2 className={`text-sm uppercase tracking-wider ${colors.text.primary} mb-4`}>SYSTEM OVERVIEW</h2>

			<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">
				<Section title="SUPPLY">
					<Metric label="JUSD" value={formatNumber(data.jusdTotalSupply, 0, 2)} valueClass={colors.text.primary} />
					<Metric label="JUICE" value={formatNumber(data.juiceTotalSupply, 0, 2)} />
				</Section>

				<Section title="RESERVES">
					<Metric label="Total" value={formatNumber(data.reserveTotal, 0, 2)} />
					<Metric label="Minter" value={formatNumber(data.reserveMinter, 0, 2)} />
					<Metric label="Equity" value={formatNumber(data.reserveEquity, 0, 2)} valueClass={colors.success} />
				</Section>

				<Section title="EQUITY">
					<Metric label="Price" value={`${formatNumber(data.equityPrice, 0, 4)}`} valueClass={colors.text.primary} />
					<Metric label="Profit" value={formatNumber(netProfit, 0, 2)} valueClass={colors.success} />
					<Metric label="24h Vol" value={formatNumber(data.equityTradeVolume24h, 0, 2) + ` (${data.equityTradeCount24h.toLocaleString()})`} />
					<Metric label="24h Delegations" value={data.equityDelegations24h.toLocaleString()} />
				</Section>

				<Section title="SAVINGS">
					<Metric label="Total" value={formatNumber(data.savingsTotal, 0, 2)} valueClass={colors.text.primary} />
					<Metric label="Interest" value={formatNumber(data.savingsInterestCollected, 0, 2)} />
					<Metric label="Rate" value={formatPercent(Number(data.savingsRate) / 10_000, 2)} />
				</Section>

				<Section title="SAVINGS 24H">
					<Metric label="Interest" value={formatNumber(data.savingsInterestCollected24h, 0, 2)} />
					<Metric label="Added" value={formatNumber(data.savingsAdded24h, 0, 2)} />
					<Metric label="Withdrawn" value={formatNumber(data.savingsWithdrawn24h, 0, 2)} />
				</Section>

				{bridges.length > 0 && (
					<Section title="BRIDGES">
						<Metric label="Active" value={`${activeBridges.length} / ${bridges.length}`} />
						<Metric label="Minted" value={formatNumber(bridgeTotalMinted, 0, 2)} valueClass={colors.text.primary} />
						<Metric label="Capacity" value={formatNumber(bridgeTotalLimit, 0, 2)} />
						<Metric label="Utilization" value={formatPercent(bridgeUtilization)} valueClass={getBridgeUtilizationColor(bridgeUtilization)} />
					</Section>
				)}
			</div>
		</div>
	);
}

function getBridgeUtilizationColor(utilization: number): string {
	if (utilization > 90) return colors.critical;
	if (utilization > 70) return colors.highlight;
	return colors.success;
}

function Metric({ label, value, valueClass = colors.text.secondary }: { label: string; value: string | number; valueClass?: string }) {
	return (
		<div className="flex justify-between">
			<span className={colors.text.secondary}>{label}</span>
			<span className={valueClass}>{value}</span>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<h3 className={`text-xs uppercase tracking-wider ${colors.text.primary} mb-2`}>{title}</h3>
			<div className={`${spacing.compact} text-sm`}>{children}</div>
		</div>
	);
}
