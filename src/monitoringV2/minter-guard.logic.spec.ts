import { ethers } from 'ethers';
import { JuiceDollarABI, EquityABI } from '@juicedollar/jusd';
import { computeHelpers, classifyDenyError, QUORUM_BPS } from './minter-guard.logic';

// Fixed 20-byte addresses (never random). Chosen so BigInt order is obvious when asserted.
const SIGNER = '0x00000000000000000000000000000000000000aa';
const HELPER_A = '0x0000000000000000000000000000000000000001';
const HELPER_B = '0x0000000000000000000000000000000000000002';
const OTHER = '0x00000000000000000000000000000000000000bb';

// Sort-order fixtures: equal-length hex whose leading digits mix 0x0f / 0x10 / 0x90.
// BigInt ascending: ADDR_0F < ADDR_10 < ADDR_90 (asserted exactly — string sort is not the contract rule).
const ADDR_0F = '0x0f00000000000000000000000000000000000001';
const ADDR_10 = '0x1000000000000000000000000000000000000001';
const ADDR_90 = '0x9000000000000000000000000000000000000001';

// Seed that slots between ADDR_0F and ADDR_10 in BigInt order.
const SEED_BETWEEN = '0x0f80000000000000000000000000000000000001';

describe('computeHelpers', () => {
	it('returns [] when nobody delegates to the signer', () => {
		// Contract: helpers only include addresses that reach the signer via _canVoteFor.
		expect(computeHelpers([{ from: HELPER_A, to: OTHER }], SIGNER)).toEqual([]);
	});

	it('collects direct delegators and excludes the signer itself', () => {
		// Contract: require(current != sender) — signer must never appear in helpers.
		const result = computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER);
		expect(result).toEqual([HELPER_A]);
		expect(result).not.toContain(SIGNER);
	});

	it('includes multi-hop intermediates (a -> b -> signer yields both a and b)', () => {
		// Equity._canVoteFor walks the chain recursively; intermediates count as helpers.
		const result = computeHelpers(
			[
				{ from: HELPER_A, to: HELPER_B },
				{ from: HELPER_B, to: SIGNER },
			],
			SIGNER
		);
		expect(result).toEqual([HELPER_A, HELPER_B]);
	});

	it('latest-wins per from: re-delegation away from the signer drops that helper', () => {
		// Input ordered ascending by block/logIndex — later entry overwrites for the same from.
		const result = computeHelpers(
			[
				{ from: HELPER_A, to: SIGNER },
				{ from: HELPER_A, to: OTHER },
			],
			SIGNER
		);
		expect(result).toEqual([]);
	});

	it('latest-wins per from: re-delegation toward the signer adds that helper', () => {
		const result = computeHelpers(
			[
				{ from: HELPER_A, to: OTHER },
				{ from: HELPER_A, to: SIGNER },
			],
			SIGNER
		);
		expect(result).toEqual([HELPER_A]);
	});

	it('is cycle-safe when a cycle includes the signer and still yields the peer helper', () => {
		// Equity allows legal delegation cycles; visited set terminates the walk.
		const result = computeHelpers(
			[
				{ from: SIGNER, to: HELPER_A },
				{ from: HELPER_A, to: SIGNER },
			],
			SIGNER
		);
		expect(result).toEqual([HELPER_A]);
	});

	it('sorts strictly ascending by BigInt(address), not by hex-string lexicography', () => {
		// Equity._checkDuplicatesAndSorted rejects helpers[i] <= helpers[i-1] (uint160 order).
		const result = computeHelpers(
			[
				{ from: ADDR_90, to: SIGNER },
				{ from: ADDR_0F, to: SIGNER },
				{ from: ADDR_10, to: SIGNER },
			],
			SIGNER
		);
		expect(result).toEqual([ADDR_0F, ADDR_10, ADDR_90]);
	});

	it('lowercases and dedupes checksummed / mixed-case input', () => {
		// All comparisons are on lowercased addresses; checksummed from/signer must not duplicate.
		const checksummedFrom = '0xAbC0000000000000000000000000000000000001';
		const mixedSigner = '0xDeF00000000000000000000000000000000000Aa';
		const result = computeHelpers([{ from: checksummedFrom, to: mixedSigner }], mixedSigner);
		expect(result).toEqual(['0xabc0000000000000000000000000000000000001']);
	});

	it('includes a seedHelpers entry not present in the delegation graph, in ascending position', () => {
		// Optional GUARD_HELPER_ADDRESS seed is unioned, then sorted with graph helpers.
		const result = computeHelpers(
			[
				{ from: ADDR_0F, to: SIGNER },
				{ from: ADDR_10, to: SIGNER },
			],
			SIGNER,
			[SEED_BETWEEN]
		);
		expect(result).toEqual([ADDR_0F, SEED_BETWEEN, ADDR_10]);
	});

	it('does not duplicate a seedHelpers entry already present in the graph', () => {
		// visited is a Set — seed union must not produce duplicates for _checkDuplicatesAndSorted.
		const result = computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER, [HELPER_A]);
		expect(result).toEqual([HELPER_A]);
	});

	it('drops a seedHelpers entry equal to the signer', () => {
		// Contract: require(current != sender) — signer seed is filtered, not an error.
		const result = computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER, [SIGNER]);
		expect(result).toEqual([HELPER_A]);
		expect(result).not.toContain(SIGNER);
	});

	it('treats seedHelpers undefined like graph-only', () => {
		const graphOnly = computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER);
		expect(computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER, undefined)).toEqual(graphOnly);
	});

	it('treats seedHelpers [] like graph-only', () => {
		const graphOnly = computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER);
		expect(computeHelpers([{ from: HELPER_A, to: SIGNER }], SIGNER, [])).toEqual(graphOnly);
	});
});

describe('classifyDenyError', () => {
	// Real ABIs so TooLate (JuiceDollar) and NotQualified (Equity) encode/decode correctly.
	const iface = new ethers.Interface([...JuiceDollarABI, ...EquityABI]);
	const tooLateData = iface.encodeErrorResult('TooLate', []);
	const notQualifiedData = iface.encodeErrorResult('NotQualified', []);

	it('classifies TooLate() as permanent (payload at error.info.error.data)', () => {
		// Application window closed — permanent; nesting shape exercises info.error.data extraction.
		const error = { message: 'execution reverted', info: { error: { data: tooLateData } } };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('permanent');
		expect(result.label).toBe('TooLate');
	});

	it('classifies NotQualified() as transient (payload at error.data)', () => {
		// Under-quorum may recover via delegation; top-level data extraction path.
		const error = { message: 'execution reverted', data: notQualifiedData };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('NotQualified');
	});

	it('classifies top-level data 0x as EmptyRevert', () => {
		// Bare requires in Equity.votesDelegated revert with no data — helper list rejected.
		const error = { message: 'execution reverted', data: '0x' };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('classifies missing revert data message with no candidate data as EmptyRevert', () => {
		const error = { message: 'call exception: missing revert data' };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('classifies error.info.error.data = 0x as EmptyRevert (info nesting path)', () => {
		// Top-level data absent; extraction must walk error.info.error.data.
		const error = { message: 'execution reverted', info: { error: { data: '0x' } } };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('classifies error.error.data = 0x as EmptyRevert (error.error nesting path)', () => {
		// Top-level data absent; extraction must walk error.error.data.
		const error = { message: 'execution reverted', error: { data: '0x' } };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('classifies undecodable non-empty data as Unknown with detail equal to the error message', () => {
		// Wrong selector at error.error.data — third nesting shape carrying real (non-0x) payload.
		const message = 'execution reverted: custom failure';
		const error = { message, error: { data: '0xdeadbeef' } };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('Unknown');
		expect(result.detail).toBe(message);
	});

	it('classifies a plain Error with no extractable data as NoRevertData (not EmptyRevert)', () => {
		// Transport/account error is not a helper-list rejection — must not match /helper/i.
		const error = new Error('nonce too low');
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('NoRevertData');
		expect(result.detail).toContain('nonce too low');
		expect(result.detail).not.toMatch(/helper/i);
	});

	it('classifies CALL_EXCEPTION with no data candidate as EmptyRevert', () => {
		// ethers v6 data-less on-chain revert: code CALL_EXCEPTION, no 0x… payload.
		const error = { message: 'execution reverted', code: 'CALL_EXCEPTION' };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('classifies a mined receipt revert (data null + receipt) as RevertedOnChain, not EmptyRevert', () => {
		// ethers v6 checkReceipt: status===0 always throws CALL_EXCEPTION with data:null and a receipt,
		// regardless of the real revert reason — must not be diagnosed as a helper-list rejection.
		const hash = '0x' + 'ab'.repeat(32);
		const error = {
			message: 'transaction execution reverted',
			code: 'CALL_EXCEPTION',
			data: null,
			receipt: { status: 0, hash },
		};
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('RevertedOnChain');
		// The detail may mention the helper list — it says the revert is NOT evidence of one. What it must
		// never carry is the pre-send diagnosis wording, which would send the operator after the wrong cause.
		expect(result.detail).not.toMatch(/unsorted|duplicated|does NOT delegate/i);
		expect(result.detail).toMatch(/mined/i);
		expect(result.detail).toContain(hash);
	});

	it('classifies the same CALL_EXCEPTION shape without a receipt as EmptyRevert (eth_call path)', () => {
		// Pre-send eth_call / estimateGas bare require: no receipt, data-less CALL_EXCEPTION —
		// that is the helper-list rejection surface, distinct from a mined status===0 receipt.
		const error = {
			message: 'transaction execution reverted',
			code: 'CALL_EXCEPTION',
			data: null,
		};
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('EmptyRevert');
		expect(result.detail).toMatch(/helper/i);
	});

	it('prefers decoded TooLate over RevertedOnChain when a mined receipt also carries error data', () => {
		// Some providers attach both receipt and decodable data on a mined revert; permanent TooLate
		// is strictly more useful than the generic mined-revert class, so decode wins.
		const error = {
			message: 'transaction execution reverted',
			code: 'CALL_EXCEPTION',
			data: tooLateData,
			receipt: { status: 0, hash: '0x' + 'cd'.repeat(32) },
		};
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('permanent');
		expect(result.label).toBe('TooLate');
	});

	it('classifies NETWORK_ERROR with no data as NoRevertData and names the code', () => {
		const error = { message: 'could not detect network', code: 'NETWORK_ERROR' };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('NoRevertData');
		expect(result.detail).toContain('NETWORK_ERROR');
		expect(result.detail).not.toMatch(/helper/i);
	});

	it('classifies TooLate() at error.error.data as permanent (error.error nesting path)', () => {
		// Coverage gap: error.error.data must carry real decodable custom-error data, not only 0x.
		const error = { message: 'execution reverted', error: { data: tooLateData } };
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('permanent');
		expect(result.label).toBe('TooLate');
	});

	it('prefers top-level error.data over error.error.data when both are present', () => {
		// Documented extraction order: error.data wins over error.info.error.data and error.error.data.
		const error = {
			message: 'execution reverted',
			data: notQualifiedData,
			error: { data: tooLateData },
		};
		const result = classifyDenyError(error, iface);
		expect(result.kind).toBe('transient');
		expect(result.label).toBe('NotQualified');
	});
});

describe('QUORUM_BPS', () => {
	it('is exactly 200n (Equity.sol private constant, absent from ABI)', () => {
		expect(QUORUM_BPS).toBe(200n);
	});
});
