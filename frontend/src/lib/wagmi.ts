import { createConfig, http, type Config } from 'wagmi';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import { defineChain } from 'viem';

// LAZY, memoized wagmi config for the Delegate button. Built on FIRST call (when the Delegate UI mounts
// inside WalletProvider), never at module load. Rationale: the config reads VITE_RPC_URL / VITE_WAGMI_ID
// fail-loud (a missing value is a hard error, never a silent fallback). If that throw fired at the entry
// point it would white-screen the whole read-only dashboard; deferring it here keeps the hard error
// contained to the Guard delegation section (see components/WalletProvider.tsx). The read path (signer
// address / voting-power % / gas) comes from the backend /guard endpoint and needs no wallet.

let cachedConfig: Config | undefined;
let cachedChainId: number | undefined;
let cachedProjectId: string | undefined;

export function buildWagmiConfig(chainId: number): Config {
	if (cachedConfig) {
		// A changing backend chain id is a real inconsistency (wrong network for equityAddress), not
		// something to silently re-create a config for — fail loud so the Delegate UI surfaces it.
		if (cachedChainId !== chainId) {
			throw new Error(`wagmi config already built for chain ${cachedChainId}, cannot rebuild for ${chainId}`);
		}
		return cachedConfig;
	}

	const rpcUrl = import.meta.env.VITE_RPC_URL;
	if (!rpcUrl) throw new Error('VITE_RPC_URL is required (wallet/delegation http transport)');

	const projectId = import.meta.env.VITE_WAGMI_ID;
	if (!projectId) throw new Error('VITE_WAGMI_ID (WalletConnect project id) is required for the Delegate button');

	cachedProjectId = projectId;
	cachedChainId = chainId;

	// Citrea mainnet is not shipped by viem/wagmi (only citreaTestnet id 5115 exists, and this service
	// dropped testnet). Define the chain locally from the backend-reported chain id so the frontend
	// cannot drift from the network Equity actually lives on. Explorer URL matches formatExplorerUrl
	// in frontend/src/lib/formatters.ts (https://citreascan.com).
	const citrea = defineChain({
		id: chainId,
		name: 'Citrea',
		nativeCurrency: { name: 'cBTC', symbol: 'cBTC', decimals: 18 },
		rpcUrls: {
			default: { http: [rpcUrl] },
		},
		blockExplorers: {
			default: { name: 'Citreascan', url: 'https://citreascan.com' },
		},
	});

	// Connector set mirrors the sibling dashboard: injected + WalletConnect + Coinbase.
	// showQrModal:false because Web3Modal renders the connect UI (see WalletProvider createWeb3Modal).
	cachedConfig = createConfig({
		chains: [citrea],
		transports: {
			[chainId]: http(rpcUrl),
		},
		connectors: [
			injected({ shimDisconnect: true }),
			walletConnect({ projectId, showQrModal: false }),
			coinbaseWallet({ appName: 'JUSD Monitor' }),
		],
	});
	return cachedConfig;
}

// WalletConnect project id, valid only AFTER buildWagmiConfig() has run (same fail-loud source).
export function getWagmiProjectId(): string {
	if (!cachedProjectId) throw new Error('buildWagmiConfig() must be called before getWagmiProjectId()');
	return cachedProjectId;
}

// Single-function ABI fragment for the Delegate button — avoids pulling a backend-only package into the
// browser bundle. delegateVoteTo does NOT reduce the caller's own votes (non-custodial and additive).
export const DELEGATE_VOTE_TO_ABI = [
	{
		type: 'function',
		name: 'delegateVoteTo',
		stateMutability: 'nonpayable',
		inputs: [{ name: 'delegate', type: 'address' }],
		outputs: [],
	},
] as const;
