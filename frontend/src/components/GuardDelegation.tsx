import { useState } from 'react';
import { useAccount, useConfig } from 'wagmi';
import { writeContract, waitForTransactionReceipt } from 'wagmi/actions';
import { useWeb3Modal } from '@web3modal/wagmi/react';
import { zeroAddress } from 'viem';
import type { GuardResponse } from '../../../shared/types';
import type { DataState } from '../lib/api.hook';
import { colors, spacing } from '../lib/theme';
import { formatPercent } from '../lib/formatters';
import { AddressLink } from './AddressLink';
import { WalletProvider } from './WalletProvider';
import { DELEGATE_VOTE_TO_ABI } from '../lib/wagmi';

type TxState = 'idle' | 'pending' | 'success' | 'error';

// Read-only guard status + (only when a live signer exists) the wallet-backed Delegate action. The
// status half needs no wallet — it renders from the backend /guard endpoint. The Delegate half is wrapped
// in a lazy WalletProvider so a missing wallet config never white-screens the dashboard (see F2).
export function GuardDelegation({ guard }: { guard?: DataState<GuardResponse> }) {
	const data = guard?.data;

	// Fail-loud on a real backend error (the endpoint 5xxs rather than faking 0%/false); render nothing
	// while the first poll is in flight, matching the other read-only sections.
	if (guard?.error) return <div className={colors.critical}>{guard.error}</div>;
	if (!data) return null;

	const pct = parseFloat(data.votingPowerPct);
	const pctColor = data.qualified ? colors.success : colors.critical;

	// F1: When the guard is disabled the backend returns signerAddress = ZeroAddress. delegateVoteTo(0x0)
	// would just point the caller's delegation at nobody (a wasted tx that supports no signer), so there
	// is NO active delegate path in that state — only the "Guard disabled" hint. Compare
	// case-insensitively (backend emits the all-zero address lowercased).
	const signerActive = data.enabled && data.signerAddress.toLowerCase() !== zeroAddress;

	return (
		<div className={`${colors.background} ${colors.table.border} border rounded-xl p-4`}>
			<h2 className={`text-sm uppercase tracking-wider ${colors.text.primary} mb-4`}>GUARD DELEGATION</h2>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
				<div className={`${spacing.compact} text-sm`}>
					<Metric label="Signer" value={<AddressLink address={data.signerAddress} colorClass={colors.link} />} />
					<Metric label="Voting power" value={<span className={pctColor}>{formatPercent(pct, 2)}</span>} />
					<Metric
						label={`Qualified (>= ${data.quorumPct}%)`}
						value={
							<span className={data.qualified ? colors.success : colors.critical}>{data.qualified ? 'Yes' : 'No'}</span>
						}
					/>
					<Metric label="Helpers" value={<span className={colors.text.primary}>{data.helperCount}</span>} />
					<Metric
						label="Gas"
						value={
							<span className={data.gasEnough ? colors.success : colors.critical}>
								{data.gasEnough ? 'Ready' : 'Low gas'} ({data.gasBalance} cBTC)
							</span>
						}
					/>
					{!data.enabled && <Metric label="Status" value={<span className={colors.text.secondary}>Guard disabled</span>} />}
				</div>

				<div className="flex flex-col justify-between gap-4">
					<p className={`${colors.text.secondary} text-xs leading-relaxed`}>
						The guard auto-denies unwhitelisted minter proposals during their application period, before they can mint.
						To act it needs at least {data.quorumPct}% of Equity voting power. Delegating your JUICE votes to the guard
						signer is <span className={colors.text.primary}>non-custodial and additive</span>: your JUICE stays in your
						wallet and your own voting power is unchanged. Unlike the usual (Governor-style) delegation that moves your
						power to the delegate, here the guard is only allowed to also count your votes toward the quorum — the signer
						holds no JUICE itself, so its veto power comes entirely from delegators. You can re-delegate at any time.
					</p>

					{signerActive ? (
						// Lazy wallet boundary around ONLY the Delegate UI. On a missing VITE_RPC_URL / VITE_WAGMI_ID the
						// wagmi config build throws fail-loud; the fallback surfaces it right here instead of killing the
						// dashboard (F2).
						<WalletProvider
							chainId={data.chainId}
							fallback={(message) => (
								<span className={`${colors.critical} text-xs`}>wallet delegation unavailable: {message}</span>
							)}
						>
							<GuardDelegateAction data={data} />
						</WalletProvider>
					) : (
						<span className={`${colors.text.secondary} text-xs`}>
							Delegation is unavailable while the guard is disabled.
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

// Wallet-backed Delegate button. Rendered only inside WalletProvider, so the wagmi/Web3Modal hooks and
// the imperative writeContract action all have their config from context.
function GuardDelegateAction({ data }: { data: GuardResponse }) {
	const config = useConfig();
	const account = useAccount();
	const { open } = useWeb3Modal();
	const [txState, setTxState] = useState<TxState>('idle');
	const [txError, setTxError] = useState<string>();

	const handleDelegate = async () => {
		if (!account.address) {
			open();
			return;
		}
		try {
			setTxState('pending');
			setTxError(undefined);
			const hash = await writeContract(config, {
				address: data.equityAddress as `0x${string}`,
				abi: DELEGATE_VOTE_TO_ABI,
				functionName: 'delegateVoteTo',
				args: [data.signerAddress as `0x${string}`],
				// F4: pin the target chain (the backend's chainId, on which equityAddress lives). The wagmi
				// config is built for that chain id, so a wallet on the wrong network is forced to switch
				// instead of silently writing to the wrong chain.
				chainId: data.chainId,
			});
			await waitForTransactionReceipt(config, { hash, confirmations: 1 });
			setTxState('success');
		} catch (error: unknown) {
			const err = error as { shortMessage?: string; message?: string };
			setTxError(err.shortMessage || err.message || 'Delegation failed');
			setTxState('error');
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				onClick={handleDelegate}
				disabled={txState === 'pending'}
				className={`px-4 py-2 rounded-lg border ${colors.table.border} ${colors.text.primary} hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed self-start`}
			>
				{txState === 'pending' ? 'Delegating…' : account.address ? 'Delegate votes to guard' : 'Connect wallet to delegate'}
			</button>
			{txState === 'success' && <span className={`${colors.success} text-xs`}>Votes delegated to the guard signer.</span>}
			{txState === 'error' && txError && <span className={`${colors.critical} text-xs`}>{txError}</span>}
		</div>
	);
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex justify-between gap-4">
			<span className={colors.text.secondary}>{label}</span>
			<span className={colors.text.primary}>{value}</span>
		</div>
	);
}
