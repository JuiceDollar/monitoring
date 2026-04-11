import { MinterStatus, MinterType, type MinterResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { formatNumber, formatCountdown, formatDateTime, formatPercent, getStatusColor } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import { colors } from '../lib/theme';
import type { DataState } from '../lib/api.hook';

interface MinterTableProps {
	data?: DataState<MinterResponse[]>;
}

export function MintersTable({ data }: MinterTableProps) {
	if (!data) return null;

	const columns: Column<MinterResponse>[] = [
		{
			header: { primary: 'MINTER', secondary: 'MESSAGE' },
			format: (minter): MultiLineCell => ({
				primary: (
					<AddressLink
						address={minter.address}
						className="font-mono"
						bridgeTokenSymbol={minter.type === MinterType.BRIDGE ? minter.bridgeTokenSymbol : undefined}
					/>
				),
				secondary: minter.status,
				secondaryClass: getStatusColor(minter.status),
			}),
		},
		{
			header: { primary: 'START', secondary: 'MESSAGE' },
			format: (minter): MultiLineCell => {
				const startTimestamp = Number(minter.applicationTimestamp) + Number(minter.applicationPeriod) * 1000;
				const hasStarted = startTimestamp <= Date.now();
				return {
					primary: hasStarted ? formatDateTime(startTimestamp) : formatCountdown(startTimestamp),
					secondary: minter.message ? minter.message.slice(0, 40) + (minter.message.length > 40 ? '...' : '') : '-',
					primaryClass: hasStarted ? undefined : colors.critical,
				};
			},
		},
		{
			header: { primary: 'MINTED', secondary: 'LIMIT' },
			align: Alignment.RIGHT,
			format: (minter): MultiLineCell => {
				const isBridge = minter.type === MinterType.BRIDGE;
				return {
					primary: isBridge ? formatNumber(minter.bridgeMinted || 0) : '-',
					secondary: isBridge ? formatNumber(minter.bridgeLimit || 0) : '-',
				};
			},
		},
		{
			header: { primary: 'UTIL. %', secondary: 'AVAILABLE' },
			align: Alignment.RIGHT,
			format: (minter) => {
				const isBridge = minter.type === MinterType.BRIDGE;
				const minted = isBridge && minter.bridgeMinted ? Number(minter.bridgeMinted) : 0;
				const limit = isBridge && minter.bridgeLimit ? Number(minter.bridgeLimit) : 0;
				const utilization = limit > 0 ? (minted * 100) / limit : undefined;
				const availableForMint = limit > 0 ? formatNumber(limit - minted) : '-';
				return {
					primary: utilization !== undefined ? formatPercent(utilization) : '-',
					secondary: availableForMint,
					primaryClass: utilization !== undefined ? getUtilizationColor(utilization) : undefined,
				};
			},
		},
		{
			header: { primary: 'EXPIRY', secondary: 'COUNTDOWN' },
			align: Alignment.RIGHT,
			format: (minter): MultiLineCell => {
				const isBridge = minter.type === MinterType.BRIDGE;
				return {
					primary: isBridge && minter.bridgeHorizon ? formatDateTime(Number(minter.bridgeHorizon)) : '-',
					secondary: isBridge && minter.bridgeHorizon ? formatCountdown(minter.bridgeHorizon) : '-',
				};
			},
		},
	];

	return (
		<Table
			title="MINTERS"
			data={data?.data}
			error={data?.error}
			columns={columns}
			getRowKey={(minter) => minter.address}
			hidden={(minter) => minter.status === MinterStatus.DENIED || minter.status === MinterStatus.EXPIRED}
			sort={(a, b) => Number(b.applicationTimestamp) - Number(a.applicationTimestamp)}
			emptyMessage="No minters found"
		/>
	);
}

function getUtilizationColor(utilization: number): string {
	if (utilization > 90) return colors.critical;
	if (utilization > 70) return colors.highlight;
	return colors.success;
}
