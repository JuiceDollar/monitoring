import { PositionStatus, type PositionResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { colors } from '../lib/theme';
import { formatNumber, formatPercent, formatDateTime, formatCountdown, getStatusColor } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import type { DataState } from '../lib/api.hook';
import { exportToCSV } from '../lib/csv-export';

interface PositionsTableProps {
	data?: DataState<PositionResponse[]>;
}

export function PositionsTable({ data }: PositionsTableProps) {
	const handleExport = () => {
		if (!data?.data) return;

		const activePositions = data.data.filter(p => !p.isClosed);
		const timestamp = new Date().toISOString().split('T')[0];

		exportToCSV(
			activePositions,
			[
				{ header: 'Created', getValue: (p) => p.created ? formatDateTime(Number(p.created)) : '-' },
				{ header: 'Status', getValue: (p) => p.status },
				{ header: 'Position Address', getValue: (p) => p.address },
				{ header: 'Owner Address', getValue: (p) => p.owner },
				{ header: 'Collateral Symbol', getValue: (p) => p.collateralSymbol },
				{ header: 'Collateral Address', getValue: (p) => p.collateral },
				{ header: 'Collateral Balance', getValue: (p) => Number(p.collateralBalance) },
				{ header: 'Liquidation Price', getValue: (p) => Number(p.virtualPrice) },
				{ header: 'Market Price', getValue: (p) => p.marketPrice ? Number(p.marketPrice) : '-' },
				{ header: 'Principal', getValue: (p) => Number(p.principal) },
				{ header: 'Interest', getValue: (p) => Number(p.interest) },
				{ header: 'Debt', getValue: (p) => Number(p.debt) },
				{ header: 'Collateralization Ratio (%)', getValue: (p) => Number(p.collateralizationRatio || 0) },
				{ header: 'Reserve Contribution (%)', getValue: (p) => (p.reserveContribution / 10000).toFixed(2) },
				{ header: 'Expiry', getValue: (p) => p.expiration ? formatDateTime(Number(p.expiration)) : '-' },
				{ header: 'Time Until Expiry', getValue: (p) => p.cooldown ? formatCountdown(p.expiration) : '-' },
			],
			`jusd-positions-${timestamp}.csv`
		);
	};

	const columns: Column<PositionResponse>[] = [
		{
			header: { primary: 'CREATED', secondary: 'STATUS' },
			format: (position): MultiLineCell => {
				const inCooldown = position.status === PositionStatus.COOLDOWN;
				const primaryContent = inCooldown
					? formatCountdown(position.cooldown)
					: position.created
						? formatDateTime(Number(position.created))
						: '-';
				return {
					primary: primaryContent,
					secondary: position.status,
					primaryClass: inCooldown ? colors.critical : undefined,
					secondaryClass: getStatusColor(position.status),
				};
			},
		},
		{
			header: { primary: 'POSITION', secondary: 'OWNER' },
			format: (position): MultiLineCell => ({
				primary: (
					<span>
						<AddressLink address={position.address} className="font-mono" />
						{position.address === position.original ? ' (O)' : ''}
					</span>
				),
				secondary: <AddressLink address={position.owner} className="font-mono" />,
			}),
		},
		{
			header: { primary: 'COLLATERAL', secondary: 'BALANCE' },
			align: Alignment.RIGHT,
			format: (position): MultiLineCell => {
				const isBtc = position.collateralSymbol.toUpperCase().includes('BTC');
				return {
					primary: <AddressLink address={position.collateral} label={position.collateralSymbol} />,
					secondary: formatNumber(Number(position.collateralBalance), 0, isBtc ? 4 : 2),
				};
			},
		},
		{
			header: { primary: 'LIQ. PRICE', secondary: 'MARKET PRICE' },
			align: Alignment.RIGHT,
			format: (position): MultiLineCell => {
				return {
					primary: formatNumber(Number(position.virtualPrice)),
					secondary: position.marketPrice ? formatNumber(Number(position.marketPrice)) : '-',
				};
			},
		},
		{
			header: { primary: 'DEBT', secondary: 'COL. %' },
			align: Alignment.RIGHT,
			format: (position): MultiLineCell => {
				const ratio = Number(position.collateralizationRatio || '0');
				return {
					primary: formatNumber(Number(position.debt)),
					secondary: formatPercent(ratio),
					secondaryClass: !position.isClosed ? getCollateralizationColor(ratio) : undefined,
				};
			},
		},
		{
			header: { primary: 'EXPIRY', secondary: 'COUNTDOWN' },
			align: Alignment.RIGHT,
			format: (position): MultiLineCell => {
				return {
					primary: position.expiration ? formatDateTime(Number(position.expiration)) : '-',
					secondary: position.cooldown ? formatCountdown(position.expiration) : '-',
				};
			},
		},
	];

	return (
		<Table
			title="POSITIONS"
			data={data?.data}
			sort={(a, b) => Number(b.created) - Number(a.created)}
			error={data?.error}
			columns={columns}
			getRowKey={(position) => position.address}
			hidden={(position) => position.isClosed}
			emptyMessage="No positions found"
			onExport={handleExport}
		/>
	);
}

export function getCollateralizationColor(ratio: number | null): string {
	if (!ratio) return colors.text.muted;
	if (ratio >= 120) return colors.success;
	if (ratio >= 105) return colors.highlight;
	return colors.critical;
}
