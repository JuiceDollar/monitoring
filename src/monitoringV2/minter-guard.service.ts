import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { JuiceDollarABI, EquityABI, ADDRESS } from '@juicedollar/jusd';
import { AppConfigService } from '../config/config.service';
import { ProviderService } from './provider.service';
import { MinterRepository } from './prisma/repositories/minter.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TelegramService } from './telegram.service';
import { MinterStatus } from './types';
import { computeHelpers, classifyDenyError, QUORUM_BPS } from './minter-guard.logic';
import { GuardResponse } from '../../shared/types';

// Cap the confirmation wait so a stuck/underpriced deny tx cannot wedge the monitoring cycle: an
// unbounded tx.wait() would block processBlocks, leaving isRunning=true so no later cycle (and none of
// the sibling alert watchers) ever runs, and — because nothing throws — no stuck-alert fires. Must be
// shorter than the EVERY_5_MINUTES cron. On timeout the throw is caught, the minter is NOT marked done,
// and it retries next cycle within the attempt cap.
const DENY_CONFIRM_TIMEOUT_MS = 180_000;

// Cooldown between repeated skip pages (in-memory only, reset on restart). Two independent timers so a
// votes-skip page and a gas-skip page never suppress each other.
const SKIP_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Rough denyMinter() gas ceiling used for the balance floor (pre-check) and the read-only /guard status
// display (gasEnough / estimated cost). Worst-case so an underfunded signer always hits the dedicated
// gas page rather than a silent estimateGas "insufficient funds" catch.
const DENY_GAS_ESTIMATE = 300_000n;

// Safety buffer (seconds) for the just-in-time TooLate pre-check: a minter whose live block timestamp is
// already within this margin of its application deadline is skipped, since denyMinter would need to be
// mined before the deadline and one that lands this close is likely to revert TooLate and waste gas.
const DENY_TOOLATE_BUFFER_SECONDS = 60n;

// Attempt cap per minter for this process lifetime, so a non-permanent failure (RPC blip, underpriced
// gas, transient EmptyRevert on a momentarily stale helper graph) cannot retry forever and page on every
// 5-minute cycle. Permanent failures (TooLate) and the cap both set done=true.
const MAX_DENY_ATTEMPTS = 3;

interface Whitelist {
	minters: string[];
}

/**
 * Raised for a guard CONFIG error that must fail loud and abort bootstrap (missing/invalid
 * GUARD_PRIVATE_KEY) — as opposed to a recoverable init error (e.g. a bad whitelist file), which
 * disables the guard and pages once without killing the whole monitoring process.
 */
export class GuardConfigError extends Error {}

/**
 * Watches for newly proposed minters and automatically denies any that are not in the configured
 * whitelist. denyMinter is a shareholder veto gated on a 2% Equity vote quorum (Equity.checkQualified),
 * inside a finite application window from suggestMinter — it is NOT an admin call.
 *
 * The watcher runs on the same EVERY_5_MINUTES cadence as the rest of monitoring (via monitoring.service).
 * That is harmless: the per-minter attempt cap, the per-minter alert dedup, and the rate-limited skip
 * pages stop the retry/alert amplification that an unbounded retry-on-every-cycle design would produce.
 * The signer must be Equity-qualified (>=2% pool-share votes, own votes plus delegators) or denyMinter
 * is skipped (not attempted). Helpers come from the indexed Delegation graph plus an optional static
 * seed (GUARD_HELPER_ADDRESS).
 */
@Injectable()
export class MinterGuardService {
	private readonly logger = new Logger(MinterGuardService.name);

	private enabled = false;
	private signerKey?: string;
	private signerAddress?: string;
	private jusdAddress?: string;
	private equityAddress?: string;
	private whitelist = new Set<string>();
	// 0 or 1 entries from the optional GUARD_HELPER_ADDRESS seed: an explicitly named helper that does not
	// depend on the indexer (fresh/reset database, in-progress backfill, indexing gap).
	private helperSeed: string[] = [];
	// Per-minter attempt/terminal state for this process lifetime. done=true means stop attempting
	// (confirmed deny, permanent rejection, or attempt cap reached). alerted=true means the terminal
	// FAILED page was already sent.
	private readonly denyState = new Map<string, { attempts: number; done?: boolean; alerted?: boolean }>();
	// In-memory skip-alert rate limiting (see SKIP_ALERT_COOLDOWN_MS).
	private lastVotesSkipAlertAt = 0;
	private lastGasSkipAlertAt = 0;
	// Built once from JuiceDollar + Equity ABIs so both TooLate and NotQualified decode.
	private denyErrorInterface?: ethers.Interface;

	constructor(
		private readonly config: AppConfigService,
		private readonly providerService: ProviderService,
		private readonly minterRepo: MinterRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly telegramService: TelegramService
	) {}

	async initialize(): Promise<void> {
		if (!this.config.guardEnabled) {
			this.logger.log('MinterGuard is DISABLED (GUARD_ENABLED != true)');
			return;
		}

		// Missing/invalid GUARD_PRIVATE_KEY is a hard CONFIG error: fail loud (GuardConfigError) so
		// bootstrap aborts. No silent fallback — an enabled guard with an unusable key is never masked.
		const pk = this.config.guardPrivateKey;
		if (!pk) throw new GuardConfigError('GUARD_ENABLED=true but GUARD_PRIVATE_KEY is missing');

		// Store the key, not a cached signer: the wallet + contract are rebuilt fresh per deny from the
		// live provider, so a provider recycle can't leave the guard on a wedged connection.
		// `new ethers.Wallet(pk)` also validates the key here (a bricked key = config error).
		let signerAddress: string;
		try {
			signerAddress = new ethers.Wallet(pk).address;
		} catch (error) {
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			throw new GuardConfigError(`GUARD_PRIVATE_KEY is invalid: ${errorMsg}`);
		}
		this.signerKey = pk;
		this.signerAddress = signerAddress;

		// GUARD_HELPER_ADDRESS is OPTIONAL: when set it seeds computeHelpers with an explicitly named helper,
		// independent of the indexer. A typo is a config error (checksum/format), not a silent ignore.
		const helper = this.config.guardHelperAddress;
		if (helper) {
			try {
				this.helperSeed = [ethers.getAddress(helper)];
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				throw new GuardConfigError(`GUARD_HELPER_ADDRESS is invalid: ${errorMsg}`);
			}
		} else {
			this.logger.log('MinterGuard: GUARD_HELPER_ADDRESS unset — helper set comes from the Delegation graph alone');
		}

		// A bad/missing whitelist file is a RECOVERABLE init error (not a config-key error): plain Error,
		// which the caller (monitoring.service) turns into disable+alert rather than an abort.
		const whitelistFile = this.config.guardWhitelistFile;
		if (!whitelistFile) throw new Error('GUARD_ENABLED=true but GUARD_WHITELIST_FILE is missing');

		const chainId = this.config.blockchainId;
		const jusdAddress = ADDRESS[chainId]?.juiceDollar;
		if (!jusdAddress) throw new Error(`No JUSD address configured for chain ${chainId}`);
		const equityAddress = ADDRESS[chainId]?.equity;
		if (!equityAddress) throw new Error(`No Equity address configured for chain ${chainId}`);

		this.jusdAddress = jusdAddress;
		this.equityAddress = equityAddress;
		// Interface covering both JuiceDollar.TooLate and Equity.NotQualified for classifyDenyError.
		this.denyErrorInterface = new ethers.Interface([...JuiceDollarABI, ...EquityABI]);

		this.loadWhitelist(whitelistFile);
		this.enabled = true;

		this.logger.log(
			`MinterGuard ENABLED: signer=${this.signerAddress}, helperSeed=${JSON.stringify(this.helperSeed)}, ` +
				`whitelist=${this.whitelist.size} entries, jusd=${jusdAddress}, equity=${equityAddress}`
		);
		// Loud, deliberate startup warnings: denyMinter is a shareholder veto, not an admin call.
		this.logger.warn(
			'MinterGuard signer must be Equity-qualified (>=2% of totalVotes, own votes plus delegators ' +
				'aggregated from Delegation events / GUARD_HELPER_ADDRESS) or denyMinter is skipped, not attempted.'
		);
		this.logger.warn(
			'MinterGuard deny window is the application period from suggestMinter and is finite — once it ' +
				'closes, denyMinter reverts TooLate for everyone and the minter will pass unchallenged.'
		);

		await this.probeQualification();
	}

	/**
	 * Startup preflight: read additive voting power (votes(signer)+Σvotes(helper)) and page once if the
	 * signer is under the 2% quorum. Deliberately does NOT abort bootstrap on not-qualified: taking the
	 * whole monitoring process down over a governance state that delegation can fix at runtime would be
	 * strictly worse than running loud-but-degraded; the state is also exposed continuously via GET /guard.
	 * A read/RPC failure is warn-only (no page, no throw) so a transient blip at boot cannot page or kill.
	 */
	private async probeQualification(): Promise<void> {
		const signerAddress = this.signerAddress;
		const equityAddress = this.equityAddress;
		if (!signerAddress || !equityAddress) return;

		try {
			const equity = new ethers.Contract(equityAddress, EquityABI, this.providerService.multicallProvider);
			const delegations = await this.eventsRepo.getDelegations();
			const helpers = computeHelpers(delegations, signerAddress, this.helperSeed);
			const voteResults = await this.providerService.callBatch<bigint>([
				() => equity.totalVotes(),
				...[signerAddress, ...helpers].map((a) => () => equity.votes(a)),
			]);
			const totalVotes: bigint = BigInt(voteResults[0]);
			const votingPower = voteResults.slice(1).reduce((sum, v) => sum + BigInt(v), 0n);
			const bps = totalVotes > 0n ? (votingPower * 10000n) / totalVotes : 0n;

			if (votingPower * 10000n < QUORUM_BPS * totalVotes) {
				this.logger.error(
					`MinterGuard startup: signer ${signerAddress} under quorum ` +
						`(${bps} bps < ${QUORUM_BPS} bps / 2%). denyMinter will be skipped until qualified.`
				);
				await this.telegramService.sendCriticalAlert(
					`⚠️ *Minter guard under 2% quorum at startup*\n\n` +
						`Signer: \`${signerAddress}\`\n` +
						`Voting power: ${bps} bps (needs >= ${QUORUM_BPS} bps / 2%)\n\n` +
						`Remedy: delegateVoteTo(${signerAddress}) on Equity, or fund the signer with JUICE.`
				);
			} else {
				this.logger.log(`MinterGuard startup: signer ${signerAddress} qualified at ${bps} bps (>= ${QUORUM_BPS} bps)`);
			}
		} catch (error) {
			// Transient RPC blip at boot must not page and must not throw (see method docstring).
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			this.logger.warn(`MinterGuard startup qualification probe failed (non-fatal): ${errorMsg}`);
		}
	}

	private loadWhitelist(path: string): void {
		try {
			const raw = fs.readFileSync(path, 'utf8');
			const parsed = JSON.parse(raw) as Whitelist;
			if (!Array.isArray(parsed.minters)) throw new Error('whitelist.minters must be an array');
			this.whitelist = new Set(parsed.minters.map((a) => a.toLowerCase()));
			// Empty whitelist = deny-by-default: EVERY new minter proposal will be denied. An unmounted
			// or truncated file looks exactly like this — make the empty state visible instead of
			// indistinguishable from a normal load.
			if (this.whitelist.size === 0) {
				this.logger.warn(
					`Loaded EMPTY whitelist from ${path} — deny-by-default is active; every new minter proposal will be denied. ` +
						`An unmounted or truncated file looks exactly like this.`
				);
			} else {
				this.logger.log(`Loaded whitelist with ${this.whitelist.size} entries from ${path}`);
			}
		} catch (error) {
			throw new Error(`Failed to load whitelist from ${path}: ${error.message}`);
		}
	}

	/**
	 * Called by MonitoringService after syncMinters(). Iterates PROPOSED minters and denies any not on
	 * the whitelist that are not already terminal in denyState. Runs a signer-global votes/gas pre-check
	 * once per cycle before any send; permanent rejections and the attempt cap stop retry amplification.
	 */
	async checkAndDeny(): Promise<void> {
		const { signerKey, signerAddress, jusdAddress } = this;
		if (!this.enabled || !signerKey || !signerAddress || !jusdAddress || !this.denyErrorInterface) return;

		const minters = await this.minterRepo.findAll();
		// Denies BRIDGE-typed proposals too: bridge type is inferred from a single
		// `usd()` view call, which is trivial to mimic in a malicious contract.
		// Legitimate new bridges must be added to the whitelist before proposal.
		const candidates = minters.filter(
			(m) =>
				m.status === MinterStatus.PROPOSED &&
				!this.whitelist.has(m.address.toLowerCase()) &&
				!this.denyState.get(m.address.toLowerCase())?.done
		);

		if (candidates.length === 0) return;

		this.logger.warn(`Found ${candidates.length} unwhitelisted PROPOSED minter(s) to deny`);

		// Build the signer + contract fresh from the live provider for this run, so a recycled
		// provider is picked up rather than a stale connection captured at initialize().
		const wallet = new ethers.Wallet(signerKey, this.providerService.provider);

		// Signer-global pre-check (once per cycle, before any deny): verify quorum + gas and build helpers.
		const precheck = await this.runDenyPrecheck(signerAddress, wallet, candidates);
		if (!precheck.ok) return;
		const helpers = precheck.helpers;

		const juiceDollar = new ethers.Contract(jusdAddress, JuiceDollarABI, wallet);

		for (const minter of candidates) {
			const address = ethers.getAddress(minter.address);
			const addrLc = address.toLowerCase();

			// Just-in-time TooLate guard. denyMinter reverts TooLate once block.timestamp >
			// minters[_minter] (applicationTimestamp + applicationPeriod). Sending into that margin only
			// burns gas — mark done so we never retry a window that can never succeed again.
			let latestBlock: ethers.Block | null = null;
			try {
				latestBlock = await this.providerService.provider.getBlock('latest');
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				this.logger.error(`MinterGuard skip ${address}: failed to read latest block for TooLate pre-check: ${errorMsg}`);
				continue;
			}
			if (!latestBlock) {
				this.logger.error(`MinterGuard skip ${address}: provider.getBlock('latest') returned null for TooLate pre-check`);
				continue;
			}
			const deadline = BigInt(minter.applicationTimestamp) + BigInt(minter.applicationPeriod);
			if (BigInt(latestBlock.timestamp) + DENY_TOOLATE_BUFFER_SECONDS >= deadline) {
				this.logger.warn(
					`MinterGuard skip ${address}: deny window closed or about to close ` +
						`(block ts ${latestBlock.timestamp} + ${DENY_TOOLATE_BUFFER_SECONDS}s buffer >= deadline ${deadline})`
				);
				const prev = this.denyState.get(addrLc) || { attempts: 0 };
				this.denyState.set(addrLc, { ...prev, done: true });
				// Alert ONCE that an unwhitelisted minter is passing unchallenged.
				if (!prev.alerted) {
					this.denyState.set(addrLc, { ...prev, done: true, alerted: true });
					await this.telegramService.sendCriticalAlert(
						`⚠️ *Unwhitelisted minter passing unchallenged*\n\n` +
							`Address: \`${address}\`\n` +
							`The application period has closed (or is within the ${DENY_TOOLATE_BUFFER_SECONDS}s buffer) — ` +
							`denyMinter is impossible; the minter will pass unless it is a bridge that can be handled otherwise.`
					);
				}
				continue;
			}

			const message = `Auto-deny by minter-guard: not in whitelist (${this.config.environment ?? 'unknown'}/${this.config.chain ?? 'unknown'})`;
			let confirmed = false;
			let txHash: string | undefined;
			try {
				const tx = await juiceDollar.denyMinter(address, helpers, message);
				txHash = tx.hash;
				this.logger.warn(`Submitted denyMinter for ${address}: tx=${tx.hash}`);
				// Bounded wait: on timeout this throws and the minter is left unmarked to retry next cycle.
				// A retry sends a fresh-nonce tx (it does not replace a stuck one); under sustained mempool/gas
				// pathology the deny may not land, but the terminal FAILED alert then pages a human — an accepted
				// limitation of the opt-in guard, deliberately not carrying nonce/replacement state.
				const receipt = await tx.wait(1, DENY_CONFIRM_TIMEOUT_MS);
				confirmed = true;
				// Confirmed on-chain from here — mark before alerting so a Telegram hiccup cannot cause a double deny.
				const prev = this.denyState.get(addrLc) || { attempts: 0 };
				this.denyState.set(addrLc, { attempts: prev.attempts, done: true });
				this.logger.warn(`denyMinter confirmed for ${address}: block=${receipt.blockNumber}`);
				await this.telegramService.sendCriticalAlert(
					`🛡️ *Minter auto-denied*\n\n` +
						`Address: \`${address}\`\n` +
						`Tx: \`${txHash}\`\n` +
						`Block: ${receipt.blockNumber}\n` +
						`Message: ${message}`
				);
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				if (confirmed) {
					// deny already landed on-chain; only post-confirmation bookkeeping/alert failed — NOT a deny failure.
					this.logger.error(
						`denyMinter confirmed but post-processing failed for ${address} (tx=${txHash}): ${errorMsg}`,
						error?.stack || error
					);
				} else {
					const classification = classifyDenyError(error, this.denyErrorInterface);
					const prev = this.denyState.get(addrLc) || { attempts: 0 };
					const attempts = prev.attempts + 1;
					const done = classification.kind === 'permanent' || attempts >= MAX_DENY_ATTEMPTS;
					this.denyState.set(addrLc, { attempts, done, alerted: prev.alerted });

					this.logger.error(
						`Failed to deny minter ${address} (attempt ${attempts}/${MAX_DENY_ATTEMPTS}, ` +
							`${classification.kind}/${classification.label}): ${classification.detail}`,
						error?.stack || error
					);

					// FAILED critical alert ONLY on the terminal state for this minter, and only once.
					// NotQualified must not produce a per-attempt page — the precheck owns that page.
					// Non-terminal transient failures log at error level and stay silent on Telegram.
					if (done && !prev.alerted) {
						this.denyState.set(addrLc, { attempts, done: true, alerted: true });
						const windowClosed = BigInt(Math.floor(Date.now() / 1000)) >= deadline;
						const remedy = windowClosed
							? 'The application period has ended — denyMinter is impossible; challenge/handle the minter otherwise if needed.'
							: 'Manual denyMinter() required before the application period ends.';
						await this.telegramService.sendCriticalAlert(
							`⚠️ *Minter auto-deny FAILED*\n\n` +
								`Address: \`${address}\`\n` +
								`Class: ${classification.label} (${classification.kind})\n` +
								`Detail: ${classification.detail}\n` +
								`Attempts: ${attempts}/${MAX_DENY_ATTEMPTS}\n\n` +
								remedy
						);
					}
				}
			}
		}
	}

	/**
	 * Signer-global deny pre-check, run once per cycle before any denyMinter(). Returns { ok, helpers }:
	 *   - ok=false => SKIP all denies this cycle (under quorum, out of gas, or a transient read error).
	 *   - Any thrown chain error is caught here and turned into a skip — nothing escapes to the cycle and
	 *     no doomed reverting tx is ever sent. Votes/gas skips page a human via rate-limited critical alerts.
	 */
	private async runDenyPrecheck(
		signerAddress: string,
		wallet: ethers.Wallet,
		candidates: Array<{ address: string }>
	): Promise<{ ok: boolean; helpers: string[] }> {
		try {
			const provider = this.providerService.provider;
			const chainId = this.config.blockchainId;
			const equity = new ethers.Contract(ADDRESS[chainId].equity, EquityABI, provider);
			const denyErrorInterface = this.denyErrorInterface as ethers.Interface;

			// Dynamic helper set from the indexed Delegation graph (+ optional static seed), sorted ascending.
			const delegations = await this.eventsRepo.getDelegations();
			let helpers = computeHelpers(delegations, signerAddress, this.helperSeed);

			// Votes check FIRST: votesDelegated is the exact value denyMinter/checkQualified use on-chain, so it
			// both validates the helper list and measures qualification. estimateGas below would itself revert
			// on NotQualified, so checking votes first keeps the two skip causes distinct.
			//
			// SEED-DROP RETRY: a stale GUARD_HELPER_ADDRESS (does not delegate to the signer / equals the
			// signer) poisons every votesDelegated read with an empty-data revert that reads like an RPC
			// fault. If EmptyRevert fires and we have a seed, retry once seed-less so a config typo cannot
			// silently disable the guard forever.
			let totalVotes: bigint;
			let delegatedVotes: bigint;
			try {
				totalVotes = BigInt(await equity.totalVotes());
				delegatedVotes = BigInt(await equity.votesDelegated(signerAddress, helpers));
			} catch (votesError) {
				const classification = classifyDenyError(votesError, denyErrorInterface);
				if (classification.label === 'EmptyRevert' && this.helperSeed.length > 0) {
					const seedLess = computeHelpers(delegations, signerAddress);
					try {
						totalVotes = BigInt(await equity.totalVotes());
						delegatedVotes = BigInt(await equity.votesDelegated(signerAddress, seedLess));
						helpers = seedLess;
						this.logger.error(
							`MinterGuard: GUARD_HELPER_ADDRESS ${this.helperSeed[0]} rejected by votesDelegated ` +
								`(EmptyRevert — does not delegate to the signer, or equals the signer). ` +
								`Continuing this cycle with the seed-less helper set; fix the env value.`
						);
						await this.maybeAlertSkip(
							'votes',
							`⚠️ *Minter guard GUARD_HELPER_ADDRESS rejected*\n\n` +
								`Seed: \`${this.helperSeed[0]}\`\n` +
								`Signer: \`${signerAddress}\`\n\n` +
								`votesDelegated reverted with empty data on the seed helper (it does not delegate to ` +
								`the signer, or equals the signer). Cycle continues with the Delegation-graph helpers only. ` +
								`Fix GUARD_HELPER_ADDRESS.`
						);
					} catch {
						// Retry also failed — rethrow the original so the outer catch skips the cycle.
						throw votesError;
					}
				} else {
					throw votesError;
				}
			}

			if (delegatedVotes * 10000n < QUORUM_BPS * totalVotes) {
				const bps = totalVotes > 0n ? (delegatedVotes * 10000n) / totalVotes : 0n;
				this.logger.warn(
					`MinterGuard SKIP: signer ${signerAddress} under quorum ` +
						`(${bps} bps < ${QUORUM_BPS} bps), ${candidates.length} candidate(s) not denied`
				);
				await this.maybeAlertSkip(
					'votes',
					`⚠️ *Minter guard under 2% quorum — deny skipped*\n\n` +
						`Signer: \`${signerAddress}\`\n` +
						`Voting power: ${bps} bps (needs >= ${QUORUM_BPS} bps / 2%)\n` +
						`${candidates.length} unwhitelisted PROPOSED minter(s) left undenied.\n\n` +
						`Delegate JUICE votes to the signer: delegateVoteTo(${signerAddress}).`
				);
				return { ok: false, helpers };
			}

			const feeData = await provider.getFeeData();
			const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
			if (gasPrice === null || gasPrice === undefined) throw new Error('feeData has neither maxFeePerGas nor gasPrice');
			const balance: bigint = await provider.getBalance(signerAddress);

			// Worst-case gas floor FIRST, independent of estimateGas: some nodes verify balance inside
			// eth_estimateGas, so an underfunded signer would revert there ("insufficient funds") and fall
			// into the generic catch below as a SILENT skip instead of this dedicated gas page. Checking the
			// balance against a fixed worst-case ceiling (DENY_GAS_ESTIMATE * fee) up front guarantees a gas
			// shortfall ALWAYS pages, before estimateGas is ever attempted. Native unit on Citrea is cBTC
			// (18 decimals — ethers.formatEther is still correct).
			const worstCaseCost = DENY_GAS_ESTIMATE * gasPrice;
			if (balance < worstCaseCost) {
				this.logger.warn(
					`MinterGuard SKIP: signer ${signerAddress} low on gas ` +
						`(balance ${ethers.formatEther(balance)} cBTC < worst-case deny cost ${ethers.formatEther(worstCaseCost)} cBTC)`
				);
				await this.maybeAlertSkip(
					'gas',
					`⚠️ *Minter guard low on cBTC — deny skipped*\n\n` +
						`Signer: \`${signerAddress}\`\n` +
						`Balance: ${ethers.formatEther(balance)} cBTC\n` +
						`Worst-case deny cost: ${ethers.formatEther(worstCaseCost)} cBTC\n` +
						`${candidates.length} unwhitelisted PROPOSED minter(s) left undenied.\n\n` +
						`Fund the signer with cBTC.`
				);
				return { ok: false, helpers };
			}

			// Precise estimate against a representative denyMinter() (cost is minter-independent to first
			// order), only after the balance floor above rules out an "insufficient funds" revert and after
			// the votes check rules out a NotQualified revert. This is BEST-EFFORT on top of the worst-case
			// floor: a sample-specific revert must NOT drop every candidate this cycle (e.g. sample just
			// crossed its own deadline). The worst-case floor already guarantees gas, and the per-candidate
			// TooLate guard + try/catch handle each send — so on estimate failure we simply proceed.
			try {
				const jusd = new ethers.Contract(ADDRESS[chainId].juiceDollar, JuiceDollarABI, wallet);
				const gasEstimate: bigint = BigInt(
					await jusd.denyMinter.estimateGas(candidates[0].address, helpers, 'minter-guard gas estimate')
				);
				const estimatedCost = gasEstimate * gasPrice;
				if (balance < estimatedCost) {
					this.logger.warn(
						`MinterGuard SKIP: signer ${signerAddress} low on gas ` +
							`(balance ${ethers.formatEther(balance)} cBTC < est. deny cost ${ethers.formatEther(estimatedCost)} cBTC)`
					);
					await this.maybeAlertSkip(
						'gas',
						`⚠️ *Minter guard low on cBTC — deny skipped*\n\n` +
							`Signer: \`${signerAddress}\`\n` +
							`Balance: ${ethers.formatEther(balance)} cBTC\n` +
							`Est. deny cost: ${ethers.formatEther(estimatedCost)} cBTC\n` +
							`${candidates.length} unwhitelisted PROPOSED minter(s) left undenied.\n\n` +
							`Fund the signer with cBTC.`
					);
					return { ok: false, helpers };
				}
			} catch (estimateError) {
				const em =
					typeof estimateError?.message === 'string' && estimateError.message ? estimateError.message : String(estimateError);
				this.logger.warn(
					`MinterGuard: sample denyMinter gas estimate on ${candidates[0].address} reverted (${em}); ` +
						`proceeding on the worst-case gas floor — the per-candidate TooLate guard and try/catch handle each send.`
				);
			}

			return { ok: true, helpers };
		} catch (error) {
			// Transient RPC error / votesDelegated revert on a momentarily stale helper graph: skip this
			// cycle (logged, not silently swallowed). It retries next cycle. runWatcher also isolates this,
			// but the explicit catch guarantees no doomed tx is sent this cycle.
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			this.logger.error(`MinterGuard pre-check failed, skipping deny this cycle: ${errorMsg}`, error?.stack || error);
			return { ok: false, helpers: [] };
		}
	}

	/** Rate-limited skip page: at most one per kind per SKIP_ALERT_COOLDOWN_MS (in-memory, reset on restart). */
	private async maybeAlertSkip(kind: 'votes' | 'gas', message: string): Promise<void> {
		const nowMs = Date.now();
		const lastAt = kind === 'votes' ? this.lastVotesSkipAlertAt : this.lastGasSkipAlertAt;
		if (nowMs - lastAt < SKIP_ALERT_COOLDOWN_MS) return;
		if (kind === 'votes') this.lastVotesSkipAlertAt = nowMs;
		else this.lastGasSkipAlertAt = nowMs;
		await this.telegramService.sendCriticalAlert(message);
	}

	/**
	 * Read-only status for the GET /guard endpoint. Fail-LOUD: a genuine on-chain read error throws (5xx)
	 * rather than faking 0%/false — the skip+alert graceful path lives only in the deny flow, never here.
	 * The private key never leaves the backend; only the derived signer address is exposed.
	 */
	async getStatus(): Promise<GuardResponse> {
		const chainId = this.config.blockchainId;
		const equityAddress = ADDRESS[chainId].equity;

		if (!this.enabled || !this.signerAddress) {
			return {
				enabled: false,
				signerAddress: ethers.ZeroAddress,
				votingPowerPct: '0',
				quorumPct: Number(QUORUM_BPS) / 100,
				qualified: false,
				helperCount: 0,
				gasBalance: '0',
				estimatedDenyCost: '0',
				gasEnough: false,
				equityAddress,
				chainId,
			};
		}

		const signerAddress = this.signerAddress;
		const provider = this.providerService.provider;
		const equity = new ethers.Contract(equityAddress, EquityABI, this.providerService.multicallProvider);

		// Additive, revert-proof voting power for DISPLAY: votes(signer) + Σ votes(helper) equals
		// votesDelegated for a valid helper set, but plain votes() never reverts on a momentarily stale graph.
		const delegations = await this.eventsRepo.getDelegations();
		const helpers = computeHelpers(delegations, signerAddress, this.helperSeed);
		const voteResults = await this.providerService.callBatch<bigint>([
			() => equity.totalVotes(),
			...[signerAddress, ...helpers].map((a) => () => equity.votes(a)),
		]);
		const totalVotes: bigint = BigInt(voteResults[0]);
		const votingPower = voteResults.slice(1).reduce((sum, v) => sum + BigInt(v), 0n);
		const qualified = votingPower * 10000n >= QUORUM_BPS * totalVotes;

		// Gas status: model denyMinter() cost with a fixed gas ceiling * live fee (see DENY_GAS_ESTIMATE).
		const balance: bigint = await provider.getBalance(signerAddress);
		const feeData = await provider.getFeeData();
		const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
		if (gasPrice === null || gasPrice === undefined) throw new Error('feeData has neither maxFeePerGas nor gasPrice');
		const estimatedDenyCost = DENY_GAS_ESTIMATE * gasPrice;

		return {
			enabled: true,
			signerAddress,
			votingPowerPct: formatVotingPowerPct(votingPower, totalVotes),
			quorumPct: Number(QUORUM_BPS) / 100,
			qualified,
			helperCount: helpers.length,
			gasBalance: ethers.formatEther(balance),
			estimatedDenyCost: ethers.formatEther(estimatedDenyCost),
			gasEnough: balance >= estimatedDenyCost,
			equityAddress,
			chainId,
		};
	}
}

/** votingPower/totalVotes as a percent string with up to 4-decimal precision (safe when total is 0). */
function formatVotingPowerPct(part: bigint, total: bigint): string {
	if (total <= 0n) return '0';
	const ppm = (part * 1_000_000n) / total; // integer parts-per-million
	return (Number(ppm) / 10_000).toString(); // -> percent
}
