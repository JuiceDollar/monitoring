import { useState, type ReactNode } from 'react';
import { WagmiProvider, type Config } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWeb3Modal } from '@web3modal/wagmi/react';
import { buildWagmiConfig, getWagmiProjectId } from '../lib/wagmi';

// One QueryClient + one Web3Modal for the whole app lifetime, created lazily on first mount of the
// Delegate UI (never at the app entry point). wagmi v2 uses @tanstack/react-query internally; only the
// wallet stack needs it, so it lives here rather than around the read-only dashboard.
const queryClient = new QueryClient();
let web3ModalInitialized = false;

/**
 * Lazy, self-contained wallet boundary around ONLY the Delegate interaction (F2).
 *
 * The wagmi config reads VITE_RPC_URL / VITE_WAGMI_ID fail-loud (no silent fallback). Building it HERE —
 * inside a boundary, on mount — instead of at the app entry point keeps that hard error contained: on a
 * missing var the Delegate UI renders the `fallback` hint while the rest of the read-only dashboard keeps
 * running, rather than the whole page white-screening. On success the children run inside WagmiProvider +
 * QueryClientProvider so the wagmi/Web3Modal hooks have their context.
 *
 * The config build + Web3Modal init run in the useState initializer so WagmiProvider gets its config
 * synchronously on the first render. Both are idempotent (buildWagmiConfig memoizes; web3ModalInitialized
 * guards createWeb3Modal), so React StrictMode's double-invoke is a safe no-op the second time.
 */
export function WalletProvider({
	chainId,
	children,
	fallback,
}: {
	chainId: number;
	children: ReactNode;
	fallback: (message: string) => ReactNode;
}) {
	const [state] = useState<{ config?: Config; error?: string }>(() => {
		try {
			const config = buildWagmiConfig(chainId);
			if (!web3ModalInitialized) {
				createWeb3Modal({ wagmiConfig: config, projectId: getWagmiProjectId(), enableAnalytics: false });
				web3ModalInitialized = true;
			}
			return { config };
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'wallet configuration error';
			return { error: message };
		}
	});

	if (state.error || !state.config) return <>{fallback(state.error ?? 'wallet configuration error')}</>;

	return (
		<WagmiProvider config={state.config}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</WagmiProvider>
	);
}
