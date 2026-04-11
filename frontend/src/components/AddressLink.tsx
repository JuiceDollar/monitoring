import { formatAddress, formatExplorerUrl } from '../lib/formatters';
import { colors } from '../lib/theme';

interface AddressLinkProps {
	address: string;
	label?: string;
	showKnownLabel?: boolean;
	className?: string;
	colorClass?: string;
	bridgeTokenSymbol?: string;
}

export function AddressLink({ address, label, showKnownLabel = true, className = '', colorClass, bridgeTokenSymbol }: AddressLinkProps) {
	const bridgeLabel = bridgeTokenSymbol ? `${bridgeTokenSymbol}-Bridge` : '';
	const displayText = label || bridgeLabel || formatAddress(address, { showKnownLabel });
	const url = formatExplorerUrl(address);
	const linkColor = colorClass || colors.text;

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className={`${linkColor} hover:underline ${className}`}
			title={address} // Show full address on hover
		>
			{displayText}
		</a>
	);
}
