import { MinterStatus, MinterType, type MinterResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { formatNumber, formatCountdown, formatDateTime, getStatusColor } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import { colors } from '../lib/theme';
import type { DataState } from '../lib/api.hook';

interface MinterTableProps {
	data?: DataState<MinterResponse[]>;
}

export function MintersTable({ data }: MinterTableProps) {
	if (!data) return null;

	const genericMinters: DataState<MinterResponse[]> = {
		data: data.data?.filter((m) => m.type !== MinterType.BRIDGE),
		error: data.error,
	};

	const columns: Column<MinterResponse>[] = [
		{
			header: { primary: 'MINTER', secondary: 'STATUS' },
			format: (minter): MultiLineCell => ({
				primary: (
					<AddressLink address={minter.address} className="font-mono" />
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
			header: { primary: 'FEE' },
			align: Alignment.RIGHT,
			format: (minter): MultiLineCell => ({
				primary: formatNumber(minter.applicationFee),
			}),
		},
	];

	return (
		<Table
			title="MINTERS"
			data={genericMinters.data}
			error={genericMinters.error}
			columns={columns}
			getRowKey={(minter) => minter.address}
			hidden={(minter) => minter.status === MinterStatus.DENIED || minter.status === MinterStatus.EXPIRED}
			sort={(a, b) => Number(b.applicationTimestamp) - Number(a.applicationTimestamp)}
			emptyMessage="No minters found"
		/>
	);
}
