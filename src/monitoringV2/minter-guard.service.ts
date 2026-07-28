import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { JuiceDollarABI, EquityABI, ADDRESS } from '@juicedollar/jusd';
import { AppConfigService } from '../config/config.service';
import { ProviderService } from './provider.service';
import { MinterRepository } from './prisma/repositories/minter.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TelegramService, escapeMarkdownText } from './telegram.service';
import { MinterStatus } from './types';
import { computeHelpers, classifyDenyError, QUORUM_BPS } from './minter-guard.logic';
import { GuardResponse } from '../../shared/types';

// Cap the confirmation wait so a stuck/underpriced deny tx cannot wedge the monitoring cycle: an
// unbounded tx.wait() would block processBlocks, leaving isRunning=true so no later cycle (and none of
// the sibling alert watchers) ever runs, and — because nothing throws — no stuck-alert fires. Must be
// shorter than the EVERY_5_MINUTES cron. On timeout the throw is caught, the minter is NOT marked done,
// and it retries next cycle within the attempt cap.
const DENY_CONFIRM_TIMEOUT_MS = 180_000;

// Per-cycle budget for sequential tx.wait confirmations across all candidates. Must stay below the
// EVERY_5_MINUTES (300s) cadence so later watchers in the same cycle are not delayed and the next
// tick does not skip on isRunning. Invariant: total confirmation wait per cycle stays under this budget.
const DENY_CYCLE_CONFIRM_BUDGET_MS = 240_000;

// Floor: if remaining confirmation budget is below this, defer remaining candidates to the next cycle
// rather than starting a deny whose confirmation cannot complete usefully within the cadence.
// A deferral is not a failure — do not mark done and do not page.
const DENY_CONFIRM_MIN_USEFUL_MS = 30_000;

// Cooldown between repeated skip pages (in-memory only, reset on restart). Independent timers per kind
// so no page class may suppress another (e.g. a reassuring seed-drop page must never swallow the critical
// under-quorum page, and a precheck failure must not share a timer with votes/gas/seed).
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

// Cap pending terminal-page retries per cycle so a backlog built during a Telegram outage cannot delay
// the time-critical deny work (each send sleeps 50ms per subscriber). Remainder waits for the next cycle.
const MAX_ALERT_RETRIES_PER_CYCLE = 5;

// Cap serial minters() reads in the resolve pass so a large PROPOSED set cannot stretch one cycle past the
// 5-minute cadence and delay every later watcher. Remainder is examined on a later cycle.
const MAX_RESOLVE_READS_PER_CYCLE = 25;

// Cap serial minters() reads in the passing-unchallenged sweep for the same cadence reason. Paired with
// round-robin resume so a fixed start cannot starve the same tail forever under the cap.
const MAX_SWEEP_READS_PER_CYCLE = 25;

// Safe Telegram body length (Telegram rejects sendMessage bodies over 4096). Comfortably under the hard
// limit so Markdown/entity overhead cannot push a page into permanent undeliverable rejection.
const MAX_ALERT_BODY_CHARS = 3500;

// Short backoff after a FAILED skip-page delivery. Full SKIP_ALERT_COOLDOWN_MS still applies on success
// (and when alerts are disabled). Trade-off: a delivered page must not repeat for an hour; a failed one
// must be retried; neither may become a per-cycle loop (twelve attempts an hour).
const SKIP_ALERT_RETRY_BACKOFF_MS = 15 * 60 * 1000;

type SkipAlertKind = 'votes' | 'gas' | 'seed' | 'precheck' | 'deadline' | 'invariant';

interface DenyStateEntry {
	attempts: number;
	done?: boolean;
	alerted?: boolean;
	/** Terminal page text awaiting confirmed Telegram delivery; cleared when alerted becomes true. */
	pendingAlert?: string;
}

interface Whitelist {
	minters: string[];
}

/** Working-set item after the resolve pass: on-chain deadline already read, ready for urgency sort + deny. */
interface ResolvedCandidate {
	address: string;
	onChainDeadline: bigint;
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
	// page was delivered (or telegram is disabled so there is nothing to retry). pendingAlert holds the
	// message when delivery failed and must be retried next cycle.
	private readonly denyState = new Map<string, DenyStateEntry>();
	// In-memory skip-alert rate limiting (see SKIP_ALERT_COOLDOWN_MS): one independent timer per kind.
	private readonly lastSkipAlertAt: Record<SkipAlertKind, number> = {
		votes: 0,
		gas: 0,
		seed: 0,
		precheck: 0,
		deadline: 0,
		invariant: 0,
	};
	// Round-robin resume for the capped sweep: address last examined when the read cap stopped the pass.
	// Next cycle starts AFTER this key so entries beyond MAX_SWEEP_READS_PER_CYCLE are not starved forever
	// under a fixed Map iteration start.
	private sweepResumeAfter?: string;
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
		// independent of the indexer. A typo is a recoverable init error (plain Error, not GuardConfigError)
		// so the caller disables the guard and pages once while the rest of monitoring keeps running —
		// an optional convenience value must never be able to take monitoring down.
		const helper = this.config.guardHelperAddress;
		if (helper) {
			try {
				const checksummed = ethers.getAddress(helper);
				// Equity.votesDelegated requires current != sender; a seed equal to the signer is dropped
				// inside computeHelpers with no diagnosis. Detect and log here so misconfig is never silent.
				if (checksummed.toLowerCase() === signerAddress.toLowerCase()) {
					this.logger.error(
						`MinterGuard: GUARD_HELPER_ADDRESS equals the guard signer (${checksummed}) — ` +
							`Equity.votesDelegated rejects that outright. Ignoring seed; helper set comes from the ` +
							`Delegation graph alone. Fix GUARD_HELPER_ADDRESS.`
					);
					this.helperSeed = [];
				} else {
					this.helperSeed = [checksummed];
				}
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				throw new Error(`GUARD_HELPER_ADDRESS is invalid: ${errorMsg}`);
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
	 * Startup preflight: obtain the same contract-truthful qualification verdict as GET /guard via
	 * evaluateQualification() (votesDelegated + seed-less retry) — deliberately NOT getStatus(), so a
	 * gas-read failure (getBalance / getFeeData) cannot suppress the under-quorum page the probe exists
	 * for. Dashboard and boot log still share the qualification half. Pages once if under the 2% quorum
	 * when helpers/seed are assessable. Deliberately does NOT abort bootstrap on not-qualified: taking the
	 * whole monitoring process down over a governance state that delegation can fix at runtime would be
	 * strictly worse than running loud-but-degraded. A qualification transport failure is warn-only (no
	 * page, no throw) so a transient blip at boot cannot page or kill.
	 *
	 * Empty delegation graph with no seed: cannot distinguish "not backfilled yet" from "genuinely nobody
	 * delegates". Consequence is at most a missing convenience page at boot — the per-cycle pre-check pages
	 * as soon as a real candidate exists. The signer's own votes are still assessed via evaluateQualification().
	 */
	private async probeQualification(): Promise<void> {
		const signerAddress = this.signerAddress;
		if (!signerAddress) return;

		const quorumPct = Number(QUORUM_BPS) / 100;

		try {
			// Qualification only — gas reads live in getStatus and must not gate this page.
			const status = await this.evaluateQualification();

			if (status.qualified) {
				this.logger.log(
					`MinterGuard startup: signer ${signerAddress} qualified at ${status.votingPowerPct}% ` +
						`(quorum ${quorumPct}%) with ${status.helperCount} helper(s)`
				);
				return;
			}

			// Under quorum: empty graph + no seed → warn only (helpers not assessable until backfill).
			// Otherwise page once so operators know the guard is armed but below threshold.
			const delegations = await this.eventsRepo.getDelegations();
			if (delegations.length === 0 && this.helperSeed.length === 0) {
				// Empty-graph early path: at most a missing convenience page at boot; per-cycle pre-check
				// pages as soon as a real candidate exists (see method docstring).
				this.logger.warn(
					`MinterGuard startup: signer ${signerAddress} alone is below the 2% quorum ` +
						`(${status.votingPowerPct}% < ${quorumPct}%); helpers cannot be assessed until the ` +
						`Delegation graph is backfilled. The per-cycle pre-check will page once a real candidate exists.`
				);
				return;
			}

			this.logger.error(
				`MinterGuard startup: signer ${signerAddress} under quorum ` +
					`(${status.votingPowerPct}% < ${quorumPct}%). denyMinter will be skipped until qualified.`
			);
			const startupMsg =
				`⚠️ *Minter guard under 2% quorum at startup*\n\n` +
				`Signer: \`${signerAddress}\`\n` +
				`Voting power: ${escapeMarkdownText(status.votingPowerPct)}% (needs >= ${quorumPct}%)\n` +
				`Helpers: ${status.helperCount}\n\n` +
				`Remedy: delegateVoteTo(${signerAddress}) on Equity, or fund the signer with JUICE.`;
			await this.telegramService.sendCriticalAlert(this.truncateAlertBody(startupMsg));
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
	 * Truncate a terminal page body to MAX_ALERT_BODY_CHARS so Telegram cannot permanently reject it
	 * (hard limit 4096). A truncated body always ends with an explicit marker so operators know text was cut.
	 * Applied before every store and every send — never retain an untruncated body as pendingAlert.
	 */
	private truncateAlertBody(message: string): string {
		if (message.length <= MAX_ALERT_BODY_CHARS) return message;
		return `${message.slice(0, MAX_ALERT_BODY_CHARS)}\n\n… (truncated)`;
	}

	/**
	 * Deliver a terminal (per-minter) critical page, honouring sendCriticalAlert's return value.
	 * On confirmed delivery sets alerted=true and clears pendingAlert. On failure keeps pendingAlert
	 * so the next cycle can retry — prevents "done + alerted with zero notification" when Telegram is down.
	 * When alerts are disabled entirely there is nothing to retry: alerted=true without pendingAlert;
	 * logger.error is the durable record (not swallowing). Bodies are always truncated (see truncateAlertBody)
	 * so a long provider error cannot make a page permanently undeliverable.
	 */
	private async deliverTerminalAlert(addrLc: string, state: DenyStateEntry, message: string): Promise<void> {
		if (state.alerted) return;

		const body = this.truncateAlertBody(message);

		// Telegram disabled: nothing to deliver to and nothing to retry — error log is the record.
		if (!this.telegramService.alertsEnabled) {
			this.denyState.set(addrLc, { ...state, alerted: true, pendingAlert: undefined });
			this.logger.error(`MinterGuard terminal page not deliverable (telegram disabled; not retained for retry): ${body}`);
			return;
		}

		const delivered = await this.telegramService.sendCriticalAlert(body);
		if (delivered) {
			this.denyState.set(addrLc, { ...state, alerted: true, pendingAlert: undefined });
		} else {
			// Store the truncated body only — retry must never re-send an oversize original.
			this.denyState.set(addrLc, { ...state, alerted: false, pendingAlert: body });
			this.logger.error(`MinterGuard terminal page could not be delivered; will retry next cycle for ${addrLc}: ${body}`);
		}
	}

	/**
	 * Re-send any terminal pages that failed delivery on a previous cycle. Notification-only —
	 * never re-sends a deny transaction. Bounded per cycle (MAX_ALERT_RETRIES_PER_CYCLE) so a
	 * backlog from an outage cannot delay the time-critical deny work; remainder waits for the next
	 * cycle (logged at warn so a truncated backlog is never mistaken for an empty one). Runs at the
	 * END of checkAndDeny even when there are no candidates — notifications are not time-critical.
	 *
	 * On a failed retry the entry is delete+re-set so Map insertion order moves it to the end: the next
	 * cycle starts with pages not tried recently. Without rotation, five permanently failing entries at
	 * the front of the map would starve every later pending page indefinitely under the per-cycle cap.
	 */
	private async retryPendingAlerts(): Promise<void> {
		const pending: Array<[string, DenyStateEntry]> = [];
		for (const [addrLc, state] of this.denyState) {
			if (state.pendingAlert && state.alerted !== true) {
				pending.push([addrLc, state]);
			}
		}

		let attempted = 0;
		for (const [addrLc, state] of pending) {
			if (attempted >= MAX_ALERT_RETRIES_PER_CYCLE) {
				const stillPending = pending.length - attempted;
				this.logger.warn(
					`MinterGuard: alert retry cap reached (${MAX_ALERT_RETRIES_PER_CYCLE} per cycle); ` +
						`${stillPending} pending page(s) still waiting for the next cycle`
				);
				break;
			}
			// pendingAlert is defined by the filter above; re-truncate in case an older entry predates the cap.
			await this.deliverTerminalAlert(addrLc, state, state.pendingAlert as string);
			attempted++;

			// Rotate failed retries to the end of Map iteration order (starvation prevention — see method).
			const after = this.denyState.get(addrLc);
			if (after && after.pendingAlert && after.alerted !== true) {
				this.denyState.delete(addrLc);
				this.denyState.set(addrLc, after);
			}
		}

		// Aggregate backlog line, independent of whether the cap truncated the pass: a page attempted this
		// cycle that STILL failed (as opposed to never attempted) would otherwise leave no summary line at
		// all when the pending count is at or below the cap — a backlog must never be invisible.
		// Individual failures keep their own log line from deliverTerminalAlert.
		let stillPendingAfter = 0;
		for (const state of this.denyState.values()) {
			if (state.pendingAlert && state.alerted !== true) stillPendingAfter++;
		}
		if (stillPendingAfter > 0) {
			this.logger.warn(
				`MinterGuard: ${stillPendingAfter} pending terminal page(s) still awaiting delivery after this cycle's retry pass`
			);
		}
	}

	/**
	 * Called by MonitoringService after syncMinters(). Iterates PROPOSED minters and denies any not on
	 * the whitelist that are not already terminal in denyState. Resolves on-chain deadlines first so the
	 * pre-check counts only genuinely actionable minters and the send loop serves the soonest veto window
	 * first. Runs a signer-global votes/gas pre-check once per cycle before any send; permanent rejections
	 * and the attempt cap stop retry amplification. Ends with a tracked-minter sweep (passing-unchallenged
	 * pages) and a bounded pending-alert retry — notifications run after deny work, never before.
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

		// Build the signer + contract fresh from the live provider for this run, so a recycled
		// provider is picked up rather than a stale connection captured at initialize().
		const wallet = new ethers.Wallet(signerKey, this.providerService.provider);
		const juiceDollar = new ethers.Contract(jusdAddress, JuiceDollarABI, wallet);

		// Addresses still in this cycle's candidate set (handled by the deny path when actionable).
		const candidateAddressSet = new Set(candidates.map((m) => m.address.toLowerCase()));

		// Resolve pass BEFORE pre-check: filter already-resolved minters, order by urgency, and give the
		// pre-check an honest actionable candidate count. Deadlines read here are NOT authoritative for the
		// send — the mapping can change while the cycle runs (another actor may deny mid-loop); the send
		// loop re-reads minters(address) immediately before each deny (see send loop).
		const workingSet: ResolvedCandidate[] = [];
		if (candidates.length > 0) {
			this.logger.warn(`Found ${candidates.length} unwhitelisted PROPOSED minter(s) to deny`);

			let resolveReads = 0;
			let resolveTruncated = false;
			for (const minter of candidates) {
				// Cap serial RPC so this pass cannot outgrow the 5-minute cadence (see MAX_RESOLVE_READS_PER_CYCLE).
				if (resolveReads >= MAX_RESOLVE_READS_PER_CYCLE) {
					resolveTruncated = true;
					break;
				}
				const address = ethers.getAddress(minter.address);
				const addrLc = address.toLowerCase();
				let onChainDeadline: bigint;
				try {
					resolveReads++;
					onChainDeadline = BigInt(await juiceDollar.minters(address));
				} catch (error) {
					// Sustained RPC fault must not let a veto window expire in silence — rate-limited page.
					const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
					this.logger.error(`MinterGuard skip ${address}: failed to read on-chain deny deadline (minters): ${errorMsg}`);
					await this.maybeAlertSkip(
						'deadline',
						`⚠️ *Minter guard could not read deny deadline*\n\n` +
							`Address: \`${address}\`\n` +
							`Detail: ${escapeMarkdownText(errorMsg)}\n\n` +
							`The on-chain application deadline could not be read this cycle; the candidate is deferred ` +
							`(not marked done). Investigate RPC if this persists — a silent window expiry must not happen.`
					);
					// Drop for this cycle only — do not mark done.
					continue;
				}
				// on-chain 0 means the minter is no longer pending (already denied, or application resolved
				// otherwise) while the indexed row is simply behind — the false-alarm class we remove: no page.
				if (onChainDeadline === 0n) {
					const prev = this.denyState.get(addrLc) || { attempts: 0 };
					this.denyState.set(addrLc, { ...prev, done: true });
					this.logger.warn(
						`MinterGuard skip ${address}: on-chain minters(address)=0 (already denied or resolved; ` +
							`indexed row still PROPOSED) — marking done without alert to avoid false "passing unchallenged" page`
					);
					continue;
				}
				// INVARIANT: every minter the guard has ever considered deniable (non-zero on-chain deadline)
				// is tracked in denyState. The sweep iterates denyState only; without this entry a candidate
				// that hits a continue path (confirmation-budget deferral, getBlock failure) or an ok:false
				// pre-check that returns before the send loop would be invisible to the sweep — and once
				// syncMinters flips the row to APPROVED the veto window can pass with no page at all.
				// Do not touch an existing entry (attempts/done/pendingAlert must survive).
				if (this.denyState.get(addrLc) === undefined) {
					this.denyState.set(addrLc, { attempts: 0 });
				}
				workingSet.push({ address, onChainDeadline });
			}
			if (resolveTruncated) {
				const notExamined = candidates.length - resolveReads;
				this.logger.warn(
					`MinterGuard: resolve pass capped at ${MAX_RESOLVE_READS_PER_CYCLE} minters() reads; ` +
						`${notExamined} candidate(s) not examined this cycle (truncated — not a completed pass)`
				);
			}
		}

		// Nothing actionable: skip pre-check (would page "N left undenied" about minters that need nothing).
		if (workingSet.length > 0) {
			// Urgency, not database order, must decide when the confirmation budget runs short: serve the
			// soonest veto window first.
			workingSet.sort((a, b) => (a.onChainDeadline < b.onChainDeadline ? -1 : a.onChainDeadline > b.onChainDeadline ? 1 : 0));

			// Signer-global pre-check (once per cycle, before any deny): verify quorum + gas and build helpers.
			// Count is the number of genuinely actionable minters after the resolve pass.
			const precheck = await this.runDenyPrecheck(signerAddress, wallet, workingSet);
			if (precheck.ok) {
				const helpers = precheck.helpers;

				// Track confirmation wait spent this cycle so sequential timeouts cannot overrun the cron cadence.
				let confirmBudgetSpentMs = 0;
				let deferDeniesLogged = false;

				for (const { address, onChainDeadline: resolveDeadline } of workingSet) {
					const addrLc = address.toLowerCase();

					// Just-in-time TooLate / already-resolved guard. denyMinter reverts TooLate once
					// block.timestamp > minters[_minter]. Re-read BOTH the live block timestamp and the
					// on-chain deadline immediately before send: the resolve-pass deadline is stale once
					// another actor denies mid-cycle (mapping deleted → 0) while we wait on a previous
					// candidate's confirmation. Sending with a stale deadline reverts, marks the minter
					// permanently failed, and pages "manual denyMinter() required" for a minter already denied.
					// currentDeadline is the authoritative value for buffer comparison and windowClosed text.
					let latestBlock: ethers.Block | null = null;
					let currentDeadline: bigint;
					try {
						latestBlock = await this.providerService.provider.getBlock('latest');
						currentDeadline = BigInt(await juiceDollar.minters(address));
					} catch (error) {
						const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
						this.logger.error(
							`MinterGuard skip ${address}: failed to re-read latest block / minters for TooLate pre-check: ${errorMsg}`
						);
						continue;
					}
					if (!latestBlock) {
						this.logger.error(`MinterGuard skip ${address}: provider.getBlock('latest') returned null for TooLate pre-check`);
						continue;
					}
					// Resolved by someone else mid-cycle: mapping entry gone — mark done, no alert (false-alarm class).
					if (currentDeadline === 0n) {
						const prev = this.denyState.get(addrLc) || { attempts: 0 };
						this.denyState.set(addrLc, { ...prev, done: true });
						this.logger.warn(
							`MinterGuard skip ${address}: on-chain minters(address)=0 at send time ` +
								`(resolved by another actor mid-cycle; resolve-pass deadline was ${resolveDeadline}) — ` +
								`marking done without alert`
						);
						continue;
					}
					if (BigInt(latestBlock.timestamp) + DENY_TOOLATE_BUFFER_SECONDS >= currentDeadline) {
						this.logger.warn(
							`MinterGuard skip ${address}: deny window closed or about to close ` +
								`(block ts ${latestBlock.timestamp} + ${DENY_TOOLATE_BUFFER_SECONDS}s buffer >= on-chain deadline ${currentDeadline})`
						);
						const prev = this.denyState.get(addrLc) || { attempts: 0 };
						const next: DenyStateEntry = { ...prev, done: true };
						this.denyState.set(addrLc, next);
						// Alert ONCE that an unwhitelisted minter is passing unchallenged (honour delivery return).
						if (!prev.alerted) {
							const alertMsg =
								`⚠️ *Unwhitelisted minter passing unchallenged*\n\n` +
								`Address: \`${address}\`\n` +
								`The application period has closed or is within the ${DENY_TOOLATE_BUFFER_SECONDS}s ` +
								`safety buffer — a deny will no longer be attempted; the minter will pass unless it ` +
								`is a bridge that can be handled otherwise.`;
							await this.deliverTerminalAlert(addrLc, next, alertMsg);
						}
						continue;
					}

					// Remaining confirmation budget too small to be useful: defer new denies (not fail) so later
					// watchers still run and the next cycle can finish the rest. Do not mark done; do not page.
					// JIT closed-window / already-resolved paths above still run for every candidate.
					// Entry was registered in the resolve pass so the sweep still sees this deferred minter.
					const remainingBudgetMs = DENY_CYCLE_CONFIRM_BUDGET_MS - confirmBudgetSpentMs;
					if (remainingBudgetMs < DENY_CONFIRM_MIN_USEFUL_MS) {
						if (!deferDeniesLogged) {
							this.logger.warn(
								`MinterGuard: confirmation budget exhausted (${confirmBudgetSpentMs}ms spent of ` +
									`${DENY_CYCLE_CONFIRM_BUDGET_MS}ms); deferring remaining deny candidate(s) including ${address} ` +
									`to the next cycle (not marked done, no page — deferral is not a failure).`
							);
							deferDeniesLogged = true;
						}
						continue;
					}

					const envLabel = `${this.config.environment ?? 'unknown'}/${this.config.chain ?? 'unknown'}`;
					const message = `Auto-deny by minter-guard: not in whitelist (${envLabel})`;
					let confirmed = false;
					let txHash: string | undefined;
					const waitTimeoutMs = Math.min(DENY_CONFIRM_TIMEOUT_MS, remainingBudgetMs);
					try {
						const tx = await juiceDollar.denyMinter(address, helpers, message);
						txHash = tx.hash;
						this.logger.warn(`Submitted denyMinter for ${address}: tx=${tx.hash}`);
						// Bounded wait within the per-cycle confirmation budget: on timeout this throws and the
						// minter is left unmarked to retry next cycle. A retry sends a fresh-nonce tx (it does not
						// replace a stuck one); under sustained mempool/gas pathology the deny may not land, but the
						// terminal FAILED alert then pages a human — an accepted limitation of the opt-in guard,
						// deliberately not carrying nonce/replacement state.
						const waitStartedAt = Date.now();
						let receipt: ethers.ContractTransactionReceipt | null;
						try {
							receipt = await tx.wait(1, waitTimeoutMs);
						} finally {
							confirmBudgetSpentMs += Date.now() - waitStartedAt;
						}
						if (!receipt) {
							// wait resolved without a receipt (should be rare with confirms=1); treat as unconfirmed for retry.
							throw new Error(`denyMinter tx.wait returned null for ${address} (tx=${txHash})`);
						}
						confirmed = true;
						// Confirmed on-chain from here — mark before alerting so a Telegram hiccup cannot cause a double deny.
						// Success page is deliberately NOT retained for retry: the deny is already on-chain, no human
						// action is required, marking must precede the alert to prevent a double deny, and a failed
						// delivery is logged at error (durable record without pendingAlert).
						const prev = this.denyState.get(addrLc) || { attempts: 0 };
						this.denyState.set(addrLc, { attempts: prev.attempts, done: true });
						this.logger.warn(`denyMinter confirmed for ${address}: block=${receipt.blockNumber}`);
						const successMsg =
							`🛡️ *Minter auto-denied*\n\n` +
							`Address: \`${address}\`\n` +
							`Tx: \`${txHash}\`\n` +
							`Block: ${receipt.blockNumber}\n` +
							`Message: ${escapeMarkdownText(message)}`;
						const delivered = await this.telegramService.sendCriticalAlert(this.truncateAlertBody(successMsg));
						// Success page does not need pendingAlert retry (deny is already on-chain and marked done),
						// but log loud when delivery fails so the gap is visible.
						if (!delivered) {
							this.logger.error(
								`MinterGuard success page could not be delivered for ${address} (tx=${txHash}); deny is on-chain`
							);
						}
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
							const next: DenyStateEntry = { attempts, done, alerted: prev.alerted, pendingAlert: prev.pendingAlert };
							this.denyState.set(addrLc, next);

							this.logger.error(
								`Failed to deny minter ${address} (attempt ${attempts}/${MAX_DENY_ATTEMPTS}, ` +
									`${classification.kind}/${classification.label}): ${classification.detail}`,
								error?.stack || error
							);

							// FAILED critical alert ONLY on the terminal state for this minter, and only once.
							// NotQualified must not produce a per-attempt page — the precheck owns that page.
							// Non-terminal transient failures log at error level and stay silent on Telegram.
							// windowClosed uses the live currentDeadline (not the resolve-pass value) so remedy
							// text stays truthful after a mid-cycle mapping change.
							if (done && !prev.alerted) {
								const windowClosed = BigInt(Math.floor(Date.now() / 1000)) >= currentDeadline;
								const remedy = windowClosed
									? 'The application period has ended — denyMinter is impossible; challenge/handle the minter otherwise if needed.'
									: 'Manual denyMinter() required before the application period ends.';
								const alertMsg =
									`⚠️ *Minter auto-deny FAILED*\n\n` +
									`Address: \`${address}\`\n` +
									`Class: ${escapeMarkdownText(classification.label)} (${classification.kind})\n` +
									`Detail: ${escapeMarkdownText(classification.detail)}\n` +
									`Attempts: ${attempts}/${MAX_DENY_ATTEMPTS}\n\n` +
									remedy;
								await this.deliverTerminalAlert(addrLc, { ...next, done: true }, alertMsg);
							}
						}
					}
				}
			}
		}

		// Sweep tracked minters that left the PROPOSED candidate set without a deny (see method).
		await this.sweepPassedUnchallenged(juiceDollar, candidateAddressSet);

		// Pending terminal pages after deny work — notifications are not time-critical; a veto window is.
		await this.retryPendingAlerts();

		// INVARIANT: every address OBSERVED this cycle (candidateAddressSet, built from the PROPOSED /
		// non-whitelisted / not-yet-done query above) must hold a denyState entry by now — "observation
		// implies tracking". The resolve pass above is what establishes this for a successfully resolved
		// candidate; this assertion exists because three separate review rounds found the same class of
		// silent pass-through (a candidate observed but never tracked, and therefore invisible to
		// sweepPassedUnchallenged once syncMinters relabels it APPROVED). A violation here means some path
		// still drops a candidate without recording it — fail loud rather than patch a fourth time.
		const untracked = [...candidateAddressSet].filter((addrLc) => this.denyState.get(addrLc) === undefined);
		if (untracked.length > 0) {
			this.logger.error(
				`MinterGuard INVARIANT VIOLATED (observation implies tracking): ${untracked.length} candidate(s) ` +
					`observed this cycle have no denyState entry: ${untracked.join(', ')}`
			);
			await this.maybeAlertSkip(
				'invariant',
				`⚠️ *Minter guard invariant violated*\n\n` +
					`${untracked.length} candidate(s) observed this cycle were never tracked in denyState ` +
					`(invariant: observation implies tracking): ${untracked.join(', ')}\n\n` +
					`This is a monitoring code defect, not a chain event — investigate the resolve/send paths.`
			);
		}
	}

	/**
	 * Bounded sweep over minters this process already tracked (denyState entries that are not done).
	 * WHY: MinterService.syncMinters() runs BEFORE checkAndDeny() every cycle and derives status from
	 * local wall-clock time (PROPOSED while currentTimestamp < startTimestamp, else APPROVED).
	 * checkAndDeny only considers PROPOSED rows, and the window-closed page only fires inside a 60s
	 * buffer while cycles run every 5 minutes — so in normal operation no cycle ever observes PROPOSED
	 * AND inside that buffer: by the next tick syncMinters has relabelled the row APPROVED, it drops
	 * out of candidates, and the "passing unchallenged" page never fires. This sweep covers exactly
	 * those previously tracked addresses without widening the candidate query to APPROVED (which would
	 * page once for every legitimately approved unwhitelisted minter on first run).
	 *
	 * Read count is capped (MAX_SWEEP_READS_PER_CYCLE) so serial minters() calls cannot stretch a cycle
	 * past the 5-minute cadence. Resume is round-robin via sweepResumeAfter: with a fixed start, entries
	 * beyond the cap would never be examined again.
	 */
	private async sweepPassedUnchallenged(juiceDollar: ethers.Contract, candidateAddresses: Set<string>): Promise<void> {
		let latestBlock: ethers.Block | null = null;
		try {
			latestBlock = await this.providerService.provider.getBlock('latest');
		} catch (error) {
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			this.logger.error(`MinterGuard sweep: failed to read latest block: ${errorMsg}`);
			return;
		}
		if (!latestBlock) {
			this.logger.error(`MinterGuard sweep: provider.getBlock('latest') returned null`);
			return;
		}
		const blockTs = BigInt(latestBlock.timestamp);

		// Snapshot keys once so round-robin index math is stable even if denyState mutates mid-pass.
		const keys = [...this.denyState.keys()];
		if (keys.length === 0) return;

		// Start after the address the previous capped pass stopped at (wrap around). If the cursor is
		// gone (entry removed) or unset, start at index 0.
		let startIdx = 0;
		if (this.sweepResumeAfter !== undefined) {
			const cursorIdx = keys.indexOf(this.sweepResumeAfter);
			if (cursorIdx >= 0) {
				startIdx = (cursorIdx + 1) % keys.length;
			}
		}

		let sweepReads = 0;
		let lastExamined: string | undefined;
		let truncated = false;
		// Eligible keys we walked past without a minters() read (done / still-candidate) do not count
		// toward the read cap; only actual RPC reads do.
		for (let i = 0; i < keys.length; i++) {
			const addrLc = keys[(startIdx + i) % keys.length];
			const state = this.denyState.get(addrLc);
			// Entry may have been removed (unlikely) or already marked done earlier in this pass.
			if (!state || state.done) continue;
			// Still in this cycle's candidate set — handled by the normal deny path.
			if (candidateAddresses.has(addrLc)) continue;

			if (sweepReads >= MAX_SWEEP_READS_PER_CYCLE) {
				truncated = true;
				break;
			}

			const address = ethers.getAddress(addrLc);
			let onChainDeadline: bigint;
			try {
				sweepReads++;
				lastExamined = addrLc;
				onChainDeadline = BigInt(await juiceDollar.minters(address));
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				this.logger.error(`MinterGuard sweep: failed to read minters(${address}): ${errorMsg}`);
				// Leave entry untouched — retries next cycle. Still advance resume so a bad RPC on one
				// address cannot pin the cursor forever.
				continue;
			}

			if (onChainDeadline === 0n) {
				// Denied by us or by someone else — mark done, no alert (false-alarm class).
				this.denyState.set(addrLc, { ...state, done: true });
				this.logger.warn(
					`MinterGuard sweep ${address}: on-chain minters(address)=0 (already denied or resolved) — ` +
						`marking done without alert`
				);
				continue;
			}

			if (blockTs < onChainDeadline) {
				// Deadline still in the future — stays a candidate next cycle if still PROPOSED; leave alone.
				continue;
			}

			// Application period ended without a deny: mark done and page exactly once via deliverTerminalAlert
			// so failed delivery inherits the retry-on-failed-delivery behaviour.
			const next: DenyStateEntry = { ...state, done: true };
			this.denyState.set(addrLc, next);
			this.logger.warn(
				`MinterGuard sweep ${address}: application period ended without deny ` +
					`(block ts ${latestBlock.timestamp} >= on-chain deadline ${onChainDeadline}) — marking done`
			);
			if (!state.alerted) {
				const alertMsg =
					`⚠️ *Unwhitelisted minter passing unchallenged*\n\n` +
					`Address: \`${address}\`\n` +
					`The application period has closed or is within the ${DENY_TOOLATE_BUFFER_SECONDS}s ` +
					`safety buffer — a deny will no longer be attempted; the minter will pass unless it ` +
					`is a bridge that can be handled otherwise.`;
				await this.deliverTerminalAlert(addrLc, next, alertMsg);
			}
		}

		// Remember where we stopped so the next cycle continues after this address (round-robin).
		// A completed full walk still advances the cursor to the last examined key so the rotation
		// keeps moving when the set stays larger than the cap across restarts of the pass.
		if (lastExamined !== undefined) {
			this.sweepResumeAfter = lastExamined;
		}

		if (truncated) {
			// Count still-eligible keys after lastExamined until we wrap back to this pass's startIdx —
			// those were not examined this cycle. No extra RPC.
			let notExamined = 0;
			const afterLast = lastExamined !== undefined ? (keys.indexOf(lastExamined) + 1) % keys.length : startIdx;
			for (let i = 0; i < keys.length; i++) {
				const idx = (afterLast + i) % keys.length;
				if (idx === startIdx) break;
				const addrLc = keys[idx];
				const state = this.denyState.get(addrLc);
				if (!state || state.done) continue;
				if (candidateAddresses.has(addrLc)) continue;
				notExamined++;
			}
			this.logger.warn(
				`MinterGuard: sweep capped at ${MAX_SWEEP_READS_PER_CYCLE} minters() reads; ` +
					`${notExamined} tracked minter(s) not examined this cycle (truncated — not a completed pass)`
			);
		}
	}

	/**
	 * Signer-global deny pre-check, run once per cycle before any denyMinter(). Returns { ok, helpers }:
	 *   - ok=true  => helpers are ready; proceed to per-candidate deny loop.
	 *   - ok=false => SKIP all denies this cycle. Paths that produce ok=false:
	 *       * under quorum (votes) — rate-limited 'votes' page when candidates exist,
	 *       * low gas — rate-limited 'gas' page when candidates exist,
	 *       * seed rejected by votesDelegated — rate-limited 'seed' page, then continues seed-less if retry works
	 *         (if seed-less also fails, falls into the generic catch),
	 *       * unusable pre-check (RPC / votesDelegated still failing) — rate-limited 'precheck' page when
	 *         candidates.length > 0 so unchallenged PROPOSED minters are never silent that cycle.
	 *   - Any thrown chain error is caught and turned into a skip — nothing escapes to the cycle and
	 *     no doomed reverting tx is ever sent.
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
			// SEED-DROP RETRY: a stale GUARD_HELPER_ADDRESS that does not delegate to the signer (or an
			// otherwise rejected helper list) poisons every votesDelegated read with an empty-data revert that
			// reads like an RPC fault. If EmptyRevert fires and we have a seed, retry once seed-less so a
			// config typo cannot silently disable the guard forever. (A seed equal to the signer is detected
			// and cleared in initialize — it never reaches this path.)
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
								`(EmptyRevert — does not delegate to the signer, or otherwise rejected helper list). ` +
								`Continuing this cycle with the seed-less helper set; fix the env value.`
						);
						await this.maybeAlertSkip(
							'seed',
							`⚠️ *Minter guard GUARD_HELPER_ADDRESS rejected*\n\n` +
								`Seed: \`${this.helperSeed[0]}\`\n` +
								`Signer: \`${signerAddress}\`\n\n` +
								`votesDelegated reverted with empty data on the seed helper (it does not delegate to ` +
								`the signer, or the helper list is otherwise rejected). Cycle continues with the ` +
								`Delegation-graph helpers only. Fix GUARD_HELPER_ADDRESS.`
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
			// Unusable pre-check (RPC failure, or votesDelegated still failing with no usable seed-less set):
			// skip this cycle (logged, not silently swallowed). When candidates exist, also page under the
			// independent 'precheck' kind so unchallenged PROPOSED minters are never only an app log line.
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			this.logger.error(`MinterGuard pre-check failed, skipping deny this cycle: ${errorMsg}`, error?.stack || error);
			if (candidates.length > 0) {
				const classification = this.denyErrorInterface
					? classifyDenyError(error, this.denyErrorInterface)
					: { label: 'Unknown', detail: errorMsg };
				await this.maybeAlertSkip(
					'precheck',
					`⚠️ *Minter guard pre-check failed — qualification unknown*\n\n` +
						`${candidates.length} unwhitelisted PROPOSED minter(s) left undenied this cycle.\n` +
						`Qualification could not be determined (class: ${escapeMarkdownText(classification.label)}).\n` +
						`Detail: ${escapeMarkdownText(classification.detail)}\n\n` +
						`The guard will retry next cycle; investigate RPC / helper set if this persists.`
				);
			}
			return { ok: false, helpers: [] };
		}
	}

	/**
	 * Rate-limited skip page: at most one per kind per SKIP_ALERT_COOLDOWN_MS (in-memory, reset on restart).
	 * Kinds have independent timers so one class of page cannot suppress another.
	 *
	 * Cooldown arming:
	 *   - SUCCESS (or telegram disabled): stamp full SKIP_ALERT_COOLDOWN_MS — a delivered page must not
	 *     be repeated for an hour.
	 *   - FAILED delivery: stamp a short SKIP_ALERT_RETRY_BACKOFF_MS window so the page is retried, but
	 *     not on every 5-minute cycle (which would be twelve attempts an hour, and per-candidate deadline
	 *     pages could fire once per failing candidate within a single cycle's retries across cycles).
	 * Trade-off explicit: delivered → quiet for an hour; failed → bounded retry; never a per-cycle loop.
	 */
	private async maybeAlertSkip(kind: SkipAlertKind, message: string): Promise<void> {
		const nowMs = Date.now();
		const lastAt = this.lastSkipAlertAt[kind];
		if (nowMs - lastAt < SKIP_ALERT_COOLDOWN_MS) return;

		// Truncate every skip-page body too — not just terminal pages (see truncateAlertBody).
		const body = this.truncateAlertBody(message);

		// Telegram disabled: nothing to deliver to — stamp full cooldown so we do not re-log every cycle.
		if (!this.telegramService.alertsEnabled) {
			this.lastSkipAlertAt[kind] = nowMs;
			this.logger.error(`MinterGuard skip page not deliverable (telegram disabled): ${body}`);
			return;
		}

		const delivered = await this.telegramService.sendCriticalAlert(body);
		if (delivered) {
			this.lastSkipAlertAt[kind] = nowMs;
		} else {
			// Short backoff only: next attempt after SKIP_ALERT_RETRY_BACKOFF_MS (see method comment).
			// lastAt is stored such that (now - lastAt) reaches SKIP_ALERT_COOLDOWN_MS after the backoff.
			this.lastSkipAlertAt[kind] = nowMs - SKIP_ALERT_COOLDOWN_MS + SKIP_ALERT_RETRY_BACKOFF_MS;
			this.logger.error(
				`MinterGuard skip page failed delivery (kind=${kind}); will retry after ` +
					`${SKIP_ALERT_RETRY_BACKOFF_MS}ms backoff: ${body}`
			);
		}
	}

	/**
	 * Qualification half of GET /guard (and the startup probe): helper derivation, votesDelegated verdict
	 * with seed-less retry, NoRevertData rethrow, and additive display fallback only when the contract
	 * rejected the helper list.
	 *
	 * ONE SNAPSHOT when votesDelegated answers: that single number is both votingPower (for
	 * votingPowerPct) and the qualified verdict; totalVotes comes from the same call sequence so the
	 * ratio is internally consistent. An additive votes() sum is ONLY an estimate when the contract
	 * refused (qualified is then false anyway) — never a second live read that can disagree with the
	 * verdict after a helper moved equity between calls.
	 *
	 * Extracted so probeQualification does not depend on gas reads (getBalance / getFeeData) that live
	 * only in getStatus — a gas-read failure must not suppress the under-quorum page.
	 */
	private async evaluateQualification(): Promise<{
		qualified: boolean;
		votingPowerPct: string;
		helperCount: number;
		totalVotes: bigint;
		votingPower: bigint;
	}> {
		const signerAddress = this.signerAddress;
		if (!signerAddress) {
			throw new Error('MinterGuard evaluateQualification: signerAddress missing while guard is enabled');
		}

		const chainId = this.config.blockchainId;
		const equityAddress = ADDRESS[chainId].equity;
		const equity = new ethers.Contract(equityAddress, EquityABI, this.providerService.multicallProvider);

		const denyIface = this.denyErrorInterface;
		if (!denyIface) throw new Error('MinterGuard evaluateQualification: denyErrorInterface missing while guard is enabled');

		const delegations = await this.eventsRepo.getDelegations();
		const helpers = computeHelpers(delegations, signerAddress, this.helperSeed);

		let activeHelpers = helpers;
		// Definite assignment: every path below either sets these via votesDelegated or the additive fallback.
		let qualified!: boolean;
		let votingPower!: bigint;
		let totalVotes!: bigint;
		// true when votesDelegated answered (primary or seed-less); false when only the additive estimate remains.
		let contractAnswered = false;

		try {
			// Same sequence: totalVotes then votesDelegated — single snapshot for ratio + verdict.
			totalVotes = BigInt(await equity.totalVotes());
			const delegatedVotes = BigInt(await equity.votesDelegated(signerAddress, helpers));
			votingPower = delegatedVotes;
			qualified = delegatedVotes * 10000n >= QUORUM_BPS * totalVotes;
			contractAnswered = true;
		} catch (error) {
			const classification = classifyDenyError(error, denyIface);
			if (classification.label === 'NoRevertData') {
				// Transport/client failure, not an on-chain rejection — fail loud for the endpoint / probe.
				throw error;
			}
			// EmptyRevert or decoded contract error: helper list rejected on-chain.
			if (this.helperSeed.length > 0) {
				const seedLess = computeHelpers(delegations, signerAddress);
				try {
					totalVotes = BigInt(await equity.totalVotes());
					const delegatedVotes = BigInt(await equity.votesDelegated(signerAddress, seedLess));
					activeHelpers = seedLess;
					votingPower = delegatedVotes;
					qualified = delegatedVotes * 10000n >= QUORUM_BPS * totalVotes;
					contractAnswered = true;
				} catch (retryError) {
					const retryClass = classifyDenyError(retryError, denyIface);
					if (retryClass.label === 'NoRevertData') throw retryError;
					// Still rejected: a real deny would also revert — report qualified:false truthfully.
					this.logger.warn(
						`MinterGuard evaluateQualification: votesDelegated rejected helper set (${retryClass.label}): ${retryClass.detail}`
					);
					qualified = false;
					activeHelpers = seedLess;
				}
			} else {
				this.logger.warn(
					`MinterGuard evaluateQualification: votesDelegated rejected helper set (${classification.label}): ${classification.detail}`
				);
				qualified = false;
			}
		}

		// Contract refused: additive votes() batch is display-only estimate; qualified stays false.
		// totalVotes and votingPower come from this same batch so the ratio stays self-consistent.
		if (!contractAnswered) {
			const voteResults = await this.providerService.callBatch<bigint>([
				() => equity.totalVotes(),
				...[signerAddress, ...activeHelpers].map((a) => () => equity.votes(a)),
			]);
			totalVotes = BigInt(voteResults[0]);
			votingPower = voteResults.slice(1).reduce((sum, v) => sum + BigInt(v), 0n);
		}

		return {
			qualified,
			votingPowerPct: formatVotingPowerPct(votingPower, totalVotes),
			helperCount: activeHelpers.length,
			totalVotes,
			votingPower,
		};
	}

	/**
	 * Read-only status for the GET /guard endpoint. Fail-LOUD: a genuine on-chain read error throws (5xx)
	 * rather than faking 0%/false — the skip+alert graceful path lives only in the deny flow, never here.
	 * The private key never leaves the backend; only the derived signer address is exposed.
	 * Qualification comes from evaluateQualification(); gas fields are appended here only.
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

		const qual = await this.evaluateQualification();

		// Gas status: model denyMinter() cost with a fixed gas ceiling * live fee (see DENY_GAS_ESTIMATE).
		const balance: bigint = await provider.getBalance(signerAddress);
		const feeData = await provider.getFeeData();
		const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
		if (gasPrice === null || gasPrice === undefined) throw new Error('feeData has neither maxFeePerGas nor gasPrice');
		const estimatedDenyCost = DENY_GAS_ESTIMATE * gasPrice;

		return {
			enabled: true,
			signerAddress,
			votingPowerPct: qual.votingPowerPct,
			quorumPct: Number(QUORUM_BPS) / 100,
			qualified: qual.qualified,
			helperCount: qual.helperCount,
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
