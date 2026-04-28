import { MinterStatus, MinterType, type MinterResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { formatNumber, formatCountdown, formatDateTime, formatPercent, getStatusColor } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import { colors } from '../lib/theme';
import type { DataState } from '../lib/api.hook';

interface BridgesTableProps {
	data?: DataState<MinterResponse[]>;
}

export function BridgesTable({ data }: BridgesTableProps) {
	if (!data) return null;

	const bridges: DataState<MinterResponse[]> = {
		data: data.data?.filter((m) => m.type === MinterType.BRIDGE),
		error: data.error,
	};

	const columns: Column<MinterResponse>[] = [
		{
			header: { primary: 'BRIDGE', secondary: 'TOKEN' },
			format: (bridge): MultiLineCell => ({
				primary: (
					<AddressLink
						address={bridge.address}
						className="font-mono"
						bridgeTokenSymbol={bridge.bridgeTokenSymbol}
					/>
				),
				secondary: bridge.bridgeToken ? (
					<AddressLink address={bridge.bridgeToken} showKnownLabel={false} className="font-mono" />
				) : '-',
			}),
		},
		{
			header: { primary: 'START', secondary: 'STATUS' },
			format: (bridge): MultiLineCell => {
				const startTimestamp = Number(bridge.applicationTimestamp) + Number(bridge.applicationPeriod) * 1000;
				const hasStarted = startTimestamp <= Date.now();
				return {
					primary: hasStarted ? formatDateTime(startTimestamp) : formatCountdown(startTimestamp),
					secondary: bridge.status,
					primaryClass: hasStarted ? undefined : colors.critical,
					secondaryClass: getStatusColor(bridge.status),
				};
			},
		},
		{
			header: { primary: 'MINTED', secondary: 'LIMIT' },
			align: Alignment.RIGHT,
			format: (bridge): MultiLineCell => ({
				primary: formatNumber(bridge.bridgeMinted || 0),
				secondary: formatNumber(bridge.bridgeLimit || 0),
			}),
		},
		{
			header: { primary: 'UTIL. %', secondary: 'AVAILABLE' },
			align: Alignment.RIGHT,
			format: (bridge): MultiLineCell => {
				const minted = bridge.bridgeMinted ? Number(bridge.bridgeMinted) : 0;
				const limit = bridge.bridgeLimit ? Number(bridge.bridgeLimit) : 0;
				const utilization = limit > 0 ? (minted * 100) / limit : undefined;
				const available = limit > 0 ? formatNumber(limit - minted) : '-';
				return {
					primary: utilization !== undefined ? formatPercent(utilization) : '-',
					secondary: available,
					primaryClass: utilization !== undefined ? getUtilizationColor(utilization) : undefined,
				};
			},
		},
		{
			header: { primary: 'EXPIRY', secondary: 'COUNTDOWN' },
			align: Alignment.RIGHT,
			format: (bridge): MultiLineCell => ({
				primary: bridge.bridgeHorizon ? formatDateTime(Number(bridge.bridgeHorizon)) : '-',
				secondary: bridge.bridgeHorizon ? formatCountdown(bridge.bridgeHorizon) : '-',
			}),
		},
	];

	return (
		<Table
			title="BRIDGES"
			data={bridges.data}
			error={bridges.error}
			columns={columns}
			getRowKey={(bridge) => bridge.address}
			hidden={(bridge) => bridge.status === MinterStatus.DENIED || bridge.status === MinterStatus.EXPIRED}
			sort={(a, b) => {
				const mintedA = a.bridgeMinted ? Number(a.bridgeMinted) : 0;
				const mintedB = b.bridgeMinted ? Number(b.bridgeMinted) : 0;
				return mintedB - mintedA;
			}}
			emptyMessage="No bridges found"
		/>
	);
}

function getUtilizationColor(utilization: number): string {
	if (utilization > 90) return colors.critical;
	if (utilization > 70) return colors.highlight;
	return colors.success;
}
