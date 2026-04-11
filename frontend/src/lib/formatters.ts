import { ChallengeStatus, MinterStatus, PositionStatus } from '../../../shared/types';
import { colors } from './theme';

const KNOWN_ADDRESSES: Record<string, string> = {
	'0x0987d3720d38847ac6dbb9d025b9de892a3ca35c': 'JuiceDollar',
	'0x2a36f2b204b46fd82653cd06d00c7ff757c99ae4': 'Equity',
	'0x3090a89a1ff5dc99117be655599e5491a0babb92': 'FrontendGateway',
	'0x22fe239892ebc8805da8f05ed3bc6af75332b60b': 'SavingsGateway',
	'0x1a20b160bf546774246c7920939e6e7ac0f88b8e': 'MintingHubGateway',
	'0xc1b97398c06b9c6a49fd9dcfac8907700301e9ac': 'Roller',
};

export function formatExplorerUrl(hash: string, type: 'address' | 'tx' = 'address'): string {
	return `https://citreascan.com/${type}/${hash}`;
}

export function formatAddress(address: string, options?: { showKnownLabel?: boolean }): string {
	if (!address || address.length < 10) return address;

	if (options?.showKnownLabel !== false) {
		const knownLabel = KNOWN_ADDRESSES[address.toLowerCase()];
		if (knownLabel) return knownLabel;
	}

	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function bigintToNumber(value: string | bigint, decimals: number = 18): number {
	const num = typeof value === 'bigint' ? value : BigInt(value);
	const divisor = BigInt(10 ** decimals);
	return Number(num) / Number(divisor);
}

function formatWithSeparators(num: number, precision: number = 2): string {
	const sign = num < 0 ? '-' : '';
	const absNum = Math.abs(num);

	if (absNum > 0 && absNum < 0.01 && precision > 2) {
		const [mantissa, expPart] = absNum.toExponential(precision).split('e');
		const exp = parseInt(expPart, 10);
		const zeroCount = Math.abs(exp) - 1;
		const digits = mantissa.replace('.', '').replace(/0+$/, '');
		return `${sign}0.0${toSubscript(zeroCount)}${digits}`;
	}

	const fixed = absNum.toFixed(precision);
	const [intPart, decPart] = fixed.split('.');
	const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
	return decPart ? `${sign}${formattedInt}.${decPart}` : `${sign}${formattedInt}`;
}

export function formatNumber(value: number | string | bigint, decimals = 0, precision = 2): string {
	const num = decimals ? bigintToNumber(value.toString(), decimals) : parseFloat(value.toString());
	return formatWithSeparators(num, precision);
}

export function formatPercent(value: number | null, precision: number = 2): string {
	if (value === null || isNaN(value)) return '-';
	return `${value.toFixed(precision)}%`;
}

export function formatDateTime(timestamp: number | Date): string {
	const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
	const day = date.getDate().toString().padStart(2, '0');
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const year = date.getFullYear();
	const hours = date.getHours().toString().padStart(2, '0');
	const minutes = date.getMinutes().toString().padStart(2, '0');
	return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Format a countdown timer or duration
 * @param value - Either a future timestamp or seconds remaining
 * @param isSeconds - If true, value is already in seconds; if false, value is a timestamp
 */
export function formatCountdown(value: number | string, isSeconds: boolean = false): string {
	const numValue = typeof value === 'string' ? Number(value) : value;
	const seconds = isSeconds ? numValue : Math.floor((numValue - Date.now()) / 1000);

	if (seconds <= 0) return '-';

	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);

	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export function getStatusColor(status: PositionStatus | MinterStatus | ChallengeStatus): string {
	switch (status) {
		case PositionStatus.OPEN:
		case MinterStatus.APPROVED:
			return colors.success;
		case PositionStatus.CHALLENGED:
		case PositionStatus.UNDERCOLLATERALIZED:
		case PositionStatus.PROPOSED:
		case PositionStatus.COOLDOWN:
		case MinterStatus.PROPOSED:
		case ChallengeStatus.AUCTION:
			return colors.critical;
		case PositionStatus.DENIED:
		case ChallengeStatus.AVERTING:
			return colors.highlight;
		case PositionStatus.CLOSED:
		case PositionStatus.EXPIRED:
		case MinterStatus.DENIED:
		case ChallengeStatus.ENDED:
			return colors.text.secondary;
		default:
			return colors.text.secondary;
	}
}

// helper functions

function toSubscript(n: number) {
	return n
		.toString()
		.split('')
		.map((d) => String.fromCharCode(0x2080 + parseInt(d, 10)))
		.join('');
}
