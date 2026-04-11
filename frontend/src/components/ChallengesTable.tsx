import { ChallengeStatus, type ChallengeResponse } from '../../../shared/types';
import { Alignment, Table } from './Table';
import type { Column, MultiLineCell } from './Table';
import { colors } from '../lib/theme';
import { formatAddress, formatNumber, formatDateTime, formatCountdown, getStatusColor } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import type { DataState } from '../lib/api.hook';

interface ChallengeTableProps {
	data?: DataState<ChallengeResponse[]>;
}

export function ChallengesTable({ data }: ChallengeTableProps) {
	const columns: Column<ChallengeResponse>[] = [
		{
			header: { primary: 'CHALLENGE', secondary: 'STATUS' },
			format: (challenge): MultiLineCell => ({
				primary: `#${challenge.id}`,
				secondary: challenge.status,
				primaryClass: colors.text.primary,
				secondaryClass: getStatusColor(challenge.status),
			}),
		},
		{
			header: { primary: 'CHALLENGER', secondary: 'POSITION' },
			format: (challenge): MultiLineCell => ({
				primary: formatAddress(challenge.challenger),
				secondary: formatAddress(challenge.position),
			}),
		},
		{
			header: { primary: 'AUCTION START', secondary: 'COUNTDOWN' },
			format: (challenge): MultiLineCell => {
				return {
					primary: formatDateTime(Number(challenge.start)),
					secondary: formatCountdown(challenge.start),
				};
			},
		},
		{
			header: { primary: 'COLLATERAL', secondary: 'BALANCE' },
			align: Alignment.RIGHT,
			format: (challenge): MultiLineCell => {
				return {
					primary: <AddressLink address={challenge.collateral} label={challenge.collateralSymbol} />,
					secondary: formatNumber(Number(challenge.collateralBalance)),
				};
			},
		},
		{
			header: { primary: 'AMOUNT', secondary: 'REMAINING' },
			align: Alignment.RIGHT,
			format: (challenge): MultiLineCell => {
				return {
					primary: formatNumber(Number(challenge.initialSize)),
					secondary: formatNumber(Number(challenge.size)),
					secondaryClass: challenge.size !== '0' ? colors.highlight : undefined,
				};
			},
		},
		{
			header: { primary: 'LIQ PRICE', secondary: 'BID' },
			align: Alignment.RIGHT,
			format: (challenge): MultiLineCell => {
				return {
					primary: formatNumber(Number(challenge.liquidationPrice)),
					secondary: formatNumber(Number(challenge.currentPrice)),
				};
			},
		},
	];

	return (
		<Table
			title="CHALLENGES"
			data={data?.data}
			error={data?.error}
			columns={columns}
			getRowKey={(challenge) => challenge.id.toString()}
			hidden={(challenge) => challenge.status === ChallengeStatus.ENDED}
			emptyMessage="No challenges found"
		/>
	);
}