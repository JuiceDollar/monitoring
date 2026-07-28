import { ethers } from 'ethers';

/** Equity QUORUM = 200 bps (2%). PRIVATE constant in Equity.sol, absent from EquityABI -> hardcoded. */
export const QUORUM_BPS = 200n;

export interface DenyErrorClass {
	kind: 'permanent' | 'transient';
	label: string; // 'TooLate' | 'NotQualified' | 'EmptyRevert' | 'RevertedOnChain' | 'NoRevertData' | a decoded error name | 'Unknown'
	detail: string; // human-readable diagnosis for logs + Telegram
}

/**
 * Pure, side-effect-free helper-set derivation for the minter-guard — the on-chain revert surface.
 *
 * Rebuilds the Equity delegation graph from the indexed Delegation(from, to) events and returns the set
 * of addresses that must be passed to JuiceDollar.denyMinter()/Equity.votesDelegated() as `helpers` so
 * the signer is Equity-qualified via its delegators. Reproduces Equity._canVoteFor (recursive, transitive):
 *   - latest-wins per `from` (delegateVoteTo overwrites the on-chain mapping; input MUST be ordered
 *     ascending by block/logIndex so the last occurrence wins),
 *   - walk the REVERSE graph from the signer (every address that transitively delegates to the signer),
 *     INCLUDING multi-hop intermediates (a -> b -> signer yields both a and b),
 *   - cycle-safe via a visited set (Equity allows legal delegation cycles),
 *   - EXCLUDE the signer itself, dedupe,
 *   - UNION the optional static seed helpers (GUARD_HELPER_ADDRESS) so an operator can name a helper
 *     explicitly without depending on the indexer (fresh/reset database, in-progress backfill, or an
 *     indexing gap), which also preserves the pre-existing single-helper configuration,
 *   - sort STRICTLY ASCENDING by BigInt(address) (uint160 order) to satisfy Equity._checkDuplicatesAndSorted
 *     — a plain string sort on hex misorders vs the contract's numeric comparison and would revert.
 *
 * All addresses are lowercased so a checksummed signer compares equal to the lowercased event args.
 */
export function computeHelpers(delegations: Array<{ from: string; to: string }>, signer: string, seedHelpers?: string[]): string[] {
	const signerLc = signer.toLowerCase();

	// Fold to the latest delegate per `from` (input already ordered ascending -> last write wins).
	const latest = new Map<string, string>();
	for (const d of delegations) {
		latest.set(d.from.toLowerCase(), d.to.toLowerCase());
	}

	// Invert to the reverse graph: delegate `to` -> [delegators `from`...].
	const incoming = new Map<string, string[]>();
	for (const [from, to] of latest) {
		const sources = incoming.get(to);
		if (sources) sources.push(from);
		else incoming.set(to, [from]);
	}

	// DFS from the signer over incoming edges, collecting every address that reaches the signer.
	const visited = new Set<string>([signerLc]);
	const stack = [signerLc];
	while (stack.length > 0) {
		const node = stack.pop() as string;
		const sources = incoming.get(node);
		if (!sources) continue;
		for (const src of sources) {
			if (!visited.has(src)) {
				visited.add(src);
				stack.push(src);
			}
		}
	}

	visited.delete(signerLc); // the signer is msg.sender, never a helper

	// Union optional static seed helpers (lowercased, signer filtered out, empty/undefined tolerated).
	if (seedHelpers) {
		for (const seed of seedHelpers) {
			if (!seed) continue;
			const seedLc = seed.toLowerCase();
			if (seedLc !== signerLc) visited.add(seedLc);
		}
	}

	return [...visited].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/**
 * Classifies a failed denyMinter/votesDelegated error into permanent vs transient with a diagnosis.
 *
 * Separates three failure surfaces:
 *   - eth_call / estimateGas bare require (empty revert data) — helper-list rejection before send,
 *   - mined receipt with status === 0 — ethers reports data:null even when a custom error fired,
 *   - client/transport/account failure — no on-chain revert marker at all.
 *
 * Permanent (TooLate): the application window has closed — retrying forever is useless and would only
 * burn gas + page. Transient: under-quorum, helper-list rejection, mined-but-reverted, RPC blips,
 * unknown — may recover next cycle (or after operator action) within the attempt cap.
 */
export function classifyDenyError(error: unknown, iface: ethers.Interface): DenyErrorClass {
	const err = error as any;
	const message = typeof err?.message === 'string' && err.message ? err.message : String(error);

	// Extract candidate revert data from the common ethers v6 / provider nesting shapes.
	const dataCandidates = [err?.data, err?.info?.error?.data, err?.error?.data];
	let data: string | undefined;
	for (const candidate of dataCandidates) {
		if (typeof candidate === 'string' && candidate.startsWith('0x')) {
			data = candidate;
			break;
		}
	}

	// Empty-data on-chain revert diagnosis (shared by the eth_call empty-data steps below).
	// Equity.votesDelegated uses BARE requires that revert with NO data:
	//   require(_checkDuplicatesAndSorted(helpers))
	//   require(current != sender)
	//   require(_canVoteFor(sender, current))
	// So this is NOT an RPC fault: the helper list was rejected on-chain.
	const emptyRevert: DenyErrorClass = {
		kind: 'transient',
		label: 'EmptyRevert',
		detail:
			'Helper list rejected on-chain with empty revert data — a helper is unsorted/duplicated, ' +
			'equals the signer, or does NOT delegate to the signer (this is NOT an RPC fault).',
	};

	// 1. Non-empty data candidate (not bare '0x'): decode first.
	// Precedence: a mined revert can carry BOTH a receipt and a decodable data payload (some providers
	// attach data even on status===0). A permanent TooLate is strictly more useful than the generic
	// RevertedOnChain class, so decode wins when both are present.
	if (data !== undefined && data !== '0x' && data !== '0X') {
		try {
			const parsed = iface.parseError(data);
			if (parsed) {
				const name = parsed.name;
				if (name === 'TooLate') {
					return {
						kind: 'permanent',
						label: 'TooLate',
						detail:
							'The application period has expired; denyMinter is impossible for anyone now — ' +
							'the minter will pass unless it is a bridge that can be handled otherwise.',
					};
				}
				if (name === 'NotQualified') {
					return {
						kind: 'transient',
						label: 'NotQualified',
						detail:
							'The signer is under the 2% Equity quorum; delegation can fix this at runtime ' +
							'(delegateVoteTo the guard signer, or fund the signer with JUICE).',
					};
				}
				const args = parsed.args?.length ? ` args=${parsed.args.map((a) => String(a)).join(',')}` : '';
				return {
					kind: 'transient',
					label: name,
					detail: `Decoded on-chain error ${name}${args}`,
				};
			}
		} catch {
			// Not a decodable custom error — fall through to Unknown.
		}

		return {
			kind: 'transient',
			label: 'Unknown',
			detail: message,
		};
	}

	// 2. Mined receipt revert (ethers checkReceipt: status===0 throws CALL_EXCEPTION with data:null
	// and a receipt). Distinct from eth_call empty-data EmptyRevert — NOT a helper-list signal.
	// kind stays transient: the authoritative on-chain window check at the start of the next cycle
	// decides whether anything is still deniable.
	const receipt = err?.receipt;
	if (receipt !== null && typeof receipt === 'object') {
		// ethers receipt uses `.hash`; some shapes expose `.transactionHash` instead.
		let hashSuffix = '';
		if (typeof receipt.hash === 'string') {
			hashSuffix = ` tx=${receipt.hash}`;
		} else if (typeof receipt.transactionHash === 'string') {
			hashSuffix = ` tx=${receipt.transactionHash}`;
		}
		return {
			kind: 'transient',
			label: 'RevertedOnChain',
			detail:
				'Transaction was mined and reverted; ethers reports data:null for mined reverts so the ' +
				'revert reason is not recoverable from the receipt. Realistic causes (most likely first): ' +
				'application window closed before inclusion (TooLate), qualification lost between pre-check ' +
				'and inclusion (NotQualified), or the application was already resolved by someone else. ' +
				'This is NOT evidence of a malformed helper list.' +
				hashSuffix,
		};
	}

	// 3. A data candidate exists and is exactly empty hex ('0x' / '0X') -> real empty-data eth_call revert.
	if (data === '0x' || data === '0X') {
		return emptyRevert;
	}

	// 4. No data candidate, but still recognisably an on-chain revert -> EmptyRevert.
	// ethers v6 surfaces a data-less CALL_EXCEPTION / "missing revert data" this way, which is what
	// distinguishes a real empty-data eth_call revert from a client/transport failure (no data, no
	// revert marker). Reached only when there is no mined receipt (step 2 above).
	const code = err?.code;
	const isOnChainEmptyRevert = message.toLowerCase().includes('missing revert data') || code === 'CALL_EXCEPTION';
	if (isOnChainEmptyRevert) {
		return emptyRevert;
	}

	// 5. No data candidate and no revert marker -> client/transport/account failure, not a helper-list
	// rejection. This class exists so we do NOT attribute network/nonce/timeout faults to the helper
	// list (which would send the operator after GUARD_HELPER_ADDRESS and trip the pre-check seed-drop).
	const codeSuffix = typeof code === 'string' && code.length > 0 ? ` code=${code}` : '';
	return {
		kind: 'transient',
		label: 'NoRevertData',
		detail:
			'Not a contract rejection: client/transport/account-level failure ' +
			'(nonce, funds at send time, timeout, network, or user rejection). ' +
			`Raw error: ${message}${codeSuffix}`,
	};
}
