import type { CollateralResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { colors } from '../lib/theme';
import { formatNumber } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import type { DataState } from '../lib/api.hook';

export function CollateralTable({ data, error }: DataState<CollateralResponse[]>) {
	if (!data) return null;

	const columns: Column<CollateralResponse>[] = [
		{
			header: { primary: 'COLLATERAL', secondary: 'ADDRESS' },
			format: (collateral): MultiLineCell => ({
				primary: collateral.symbol,
				secondary: <AddressLink address={collateral.collateral} showKnownLabel={false} className="font-mono" />,
				primaryClass: colors.text.primary,
			}),
		},
		{
			header: { primary: 'TOTAL LOCKED', secondary: 'POSITIONS' },
			align: Alignment.RIGHT,
			format: (collateral): MultiLineCell => ({
				primary: formatNumber(Number(collateral.totalCollateral)),
				secondary: `${collateral.positionCount} positions`,
			}),
		},
		{
			header: { primary: 'TVL (EUR)', secondary: 'PRICE (EUR)' },
			align: Alignment.RIGHT,
			format: (collateral): MultiLineCell => {
				const price = parseFloat(collateral.price);
				const totalLocked = parseFloat(collateral.totalCollateral);
				const tvl = price * totalLocked;
				return {
					primary: tvl !== 0 ? formatNumber(Number(tvl)) : '-',
					secondary: price !== 0 ? formatNumber(price) : '-',
				};
			},
		},
		{
			header: { primary: 'MINT LIMIT', secondary: 'AVAILABLE' },
			align: Alignment.RIGHT,
			format: (collateral): MultiLineCell => ({
				primary: formatNumber(Number(collateral.totalLimit)),
				secondary: formatNumber(Number(collateral.totalAvailableForMinting)),
				secondaryClass: collateral.totalAvailableForMinting !== '0' ? colors.success : undefined,
			}),
		},
	];

	return (
		<Table
			title="COLLATERAL"
			data={data}
			error={error}
			columns={columns}
			getRowKey={(collateral) => collateral.collateral}
			hidden={(collateral) => collateral.totalLimit === '0'}
			emptyMessage="No collateral found"
		/>
	);
}
