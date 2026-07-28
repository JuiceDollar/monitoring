import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { JuiceDollarABI, EquityABI, ADDRESS } from '@juicedollar/jusd';
import { AppConfigService } from '../config/config.service';
import { ProviderService } from './provider.service';
import { MinterRepository } from './prisma/repositories/minter.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TelegramService, escapeMarkdownText, truncateAlertBody } from './telegram.service';
import { MinterStatus } from './types';
import { computeHelpers, classifyDenyError, QUORUM_BPS } from './minter-guard.logic';
import { GuardResponse } from '../../shared/types';

// Cap the confirmation wait so a stuck/underpriced deny tx cannot wedge the monitoring cycle: an
// unbounded tx.wait() would block processBlocks, leaving isRunning=true so no later cycle (and none of
// the sibling alert watchers) ever runs, and — because nothing throws — no stuck-alert fires. Must be
// shorter than the EVERY_5_MINUTES cron. On timeout the throw is caught, the minter is NOT marked done,
// and it retries next cycle within the attempt cap. Per-tx wait is further capped by cycleRemainingMs.
const DENY_CONFIRM_TIMEOUT_MS = 180_000;

// Comfortably below the EVERY_5_MINUTES cadence; the whole guard cycle must fit inside it, because
// monitoring.service guards the cycle with one isRunning flag and an overrun costs the next tick.
// Single deadline for resolve pass, send-loop JIT reads + confirms, sweep, and pending-alert retries —
// replaces the earlier separate RPC_PASS_BUDGET_MS / DENY_CYCLE_CONFIRM_BUDGET_MS budgets (and the
// confirmBudgetSpentMs accumulator). Three separate meters could not express the cycle-wide invariant,
// and the per-candidate JIT reads in the send loop had no budget at all; worst case summed well past
// the cadence while veto windows kept moving.
const CYCLE_BUDGET_MS = 240_000;

// Floor: if remaining cycle budget is below this, defer remaining candidates to the next cycle
// rather than starting a deny whose confirmation cannot complete usefully within the cadence.
// A deferral is not a failure — do not mark done and do not page.
const DENY_CONFIRM_MIN_USEFUL_MS = 30_000;

// Cooldown between repeated skip pages (in-memory only, reset on restart). Independent timers per kind
// so no page class may suppress another (e.g. a reassuring seed-drop page must never swallow the critical
// under-quorum page, and a precheck failure must not share a timer with votes/gas/seed).
const SKIP_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Helper-count-aware denyMinter() gas ceiling for the balance floor (pre-check) and the read-only
// /guard status display (gasEnough / estimated cost). Deliberately rough upper bound whose ONLY job
// is to make an obviously underfunded signer page before a doomed send; the precise estimateGas call
// immediately afterwards is the accurate check — so the floor is intentionally permissive rather than
// protective. A too-high per-helper term with a large helper set invented a shortfall that did not
// exist and vetoed every candidate for the cycle (worse than the out-of-gas risk the ceiling covers).
// DENY_GAS_CEILING_MAX caps inflation so a large helper set cannot push the floor without bound.
const DENY_GAS_BASE = 200_000n;
const DENY_GAS_PER_HELPER = 8_000n;
const DENY_GAS_CEILING_MAX = 1_000_000n;

/** Worst-case gas ceiling for denyMinter given the helper list length (see DENY_GAS_* constants). */
function denyGasCeiling(helperCount: number): bigint {
	const uncapped = DENY_GAS_BASE + BigInt(helperCount) * DENY_GAS_PER_HELPER;
	return uncapped > DENY_GAS_CEILING_MAX ? DENY_GAS_CEILING_MAX : uncapped;
}

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
	// Last undelivered skip page, keyed by page (kind alone for cycle-global pages; `${kind}:${dedupKey}`
	// for per-candidate pages such as deadline). COOLDOWN stays per kind — it limits how often a CLASS of
	// page fires; only retention and retry bookkeeping are per page, so a delivered page for minter B
	// cannot destroy an undelivered page for minter A of the same kind. Terminal pages already use
	// denyState.pendingAlert; skip pages must be retained the same way so a page is not lost when the
	// condition stops recurring. Retried in retryPendingAlerts under the shared MAX_ALERT_RETRIES_PER_CYCLE
	// budget; cleared only on confirmed delivery.
	private readonly pendingSkipAlerts = new Map<string, string>();
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
			const delivered = await this.telegramService.sendCriticalAlert(truncateAlertBody(startupMsg));
			// No pendingAlert-style retry at startup: the per-cycle pre-check pages the same under-quorum
			// condition as soon as a real candidate exists.
			if (!delivered) {
				this.logger.error(
					`MinterGuard startup under-quorum page could not be delivered; guard is unqualified for this run ` +
						`(signer ${signerAddress})`
				);
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
	 * Deliver a terminal (per-minter) critical page, honouring sendCriticalAlert's return value.
	 * On confirmed delivery sets alerted=true and clears pendingAlert. On failure keeps pendingAlert
	 * so the next cycle can retry — prevents "done + alerted with zero notification" when Telegram is down.
	 * When alerts are disabled entirely there is nothing to retry: alerted=true without pendingAlert;
	 * logger.error is the durable record (not swallowing). Bodies are always truncated (see truncateAlertBody)
	 * so a long provider error cannot make a page permanently undeliverable.
	 */
	private async deliverTerminalAlert(addrLc: string, state: DenyStateEntry, message: string): Promise<void> {
		if (state.alerted) return;

		const body = truncateAlertBody(message);

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
	 * Re-send any terminal pages and undelivered skip pages that failed delivery. Notification-only —
	 * never re-sends a deny transaction. Bounded per cycle (MAX_ALERT_RETRIES_PER_CYCLE) so a backlog from
	 * an outage cannot delay the time-critical deny work; remainder waits for a later cycle (logged at
	 * warn so a truncated backlog is never mistaken for an empty one). Runs at the END of checkAndDeny
	 * even when there are no candidates — notifications are not time-critical.
	 *
	 * A page stored during the current checkAndDeny is retried in this same invocation's end-of-cycle
	 * pass, then on every later cycle until delivered or the cap defers it. That immediate second attempt
	 * is harmless and often useful (Telegram blips are often short-lived).
	 *
	 * Skip pages share the same per-cycle cap as terminal pages (no separate budget). A page describing a
	 * condition that no longer holds is still worth delivering: it tells the operator what happened while
	 * they could not be reached.
	 *
	 * On a failed terminal retry the entry is delete+re-set so Map insertion order moves it to the end: the
	 * next cycle starts with pages not tried recently. Without rotation, five permanently failing entries at
	 * the front of the map would starve every later pending page indefinitely under the per-cycle cap.
	 * The same delete+re-set rotation applies to failed skip-page retries for the same reason (deadline pages
	 * are keyed per minter, so more than MAX_ALERT_RETRIES_PER_CYCLE skip entries is now plausible).
	 */
	private async retryPendingAlerts(cycleStartedAt: number): Promise<void> {
		const pending: Array<[string, DenyStateEntry]> = [];
		for (const [addrLc, state] of this.denyState) {
			if (state.pendingAlert && state.alerted !== true) {
				pending.push([addrLc, state]);
			}
		}
		// Snapshot skip entries so iteration is stable while the map may clear on success.
		// Keys are page-level (kind or kind:dedupKey); see pendingSkipAlerts.
		const pendingSkips: Array<[string, string]> = [...this.pendingSkipAlerts.entries()];
		const totalPendingAtStart = pending.length + pendingSkips.length;

		let attempted = 0;
		let capWarned = false;
		let deadlineWarned = false;
		for (const [addrLc, state] of pending) {
			// Respect the single cycle deadline so a Telegram backlog cannot overrun the cadence.
			if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
				if (!deadlineWarned) {
					const stillPending = totalPendingAtStart - attempted;
					this.logger.warn(
						`MinterGuard: alert retry stopped (cycle deadline ${CYCLE_BUDGET_MS}ms); ` +
							`${stillPending} pending page(s) still waiting for the next cycle`
					);
					deadlineWarned = true;
				}
				break;
			}
			if (attempted >= MAX_ALERT_RETRIES_PER_CYCLE) {
				const stillPending = totalPendingAtStart - attempted;
				this.logger.warn(
					`MinterGuard: alert retry cap reached (${MAX_ALERT_RETRIES_PER_CYCLE} per cycle); ` +
						`${stillPending} pending page(s) still waiting for the next cycle`
				);
				capWarned = true;
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

		// Retry undelivered skip pages under the same per-cycle cap (not a separate budget).
		for (const [retentionKey, message] of pendingSkips) {
			if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
				if (!deadlineWarned) {
					const stillPending = totalPendingAtStart - attempted;
					this.logger.warn(
						`MinterGuard: alert retry stopped (cycle deadline ${CYCLE_BUDGET_MS}ms); ` +
							`${stillPending} pending page(s) still waiting for the next cycle`
					);
					deadlineWarned = true;
				}
				break;
			}
			if (attempted >= MAX_ALERT_RETRIES_PER_CYCLE) {
				if (!capWarned) {
					const stillPending = totalPendingAtStart - attempted;
					this.logger.warn(
						`MinterGuard: alert retry cap reached (${MAX_ALERT_RETRIES_PER_CYCLE} per cycle); ` +
							`${stillPending} pending page(s) still waiting for the next cycle`
					);
					capWarned = true;
				}
				break;
			}
			// May have been cleared if maybeAlertSkip delivered the same page later in this cycle.
			if (!this.pendingSkipAlerts.has(retentionKey)) continue;

			// Kind prefix of the retention key (cooldown is per kind, not per page — see maybeAlertSkip).
			const colon = retentionKey.indexOf(':');
			const kind = (colon === -1 ? retentionKey : retentionKey.slice(0, colon)) as SkipAlertKind;

			// Re-truncate in case an older retained body predates the helper move; never re-send oversize text.
			const body = truncateAlertBody(message);
			if (!this.telegramService.alertsEnabled) {
				// Nothing to deliver to — drop retention (same durable record as maybeAlertSkip when disabled).
				this.pendingSkipAlerts.delete(retentionKey);
				this.lastSkipAlertAt[kind] = Date.now();
				this.logger.error(`MinterGuard skip page not deliverable on retry (telegram disabled; not retained): ${body}`);
				attempted++;
				continue;
			}

			const delivered = await this.telegramService.sendCriticalAlert(body);
			attempted++;
			if (delivered) {
				this.pendingSkipAlerts.delete(retentionKey);
				// Confirmed delivery: arm full cooldown so the same kind does not re-page for an hour.
				this.lastSkipAlertAt[kind] = Date.now();
			} else {
				// Keep retained body for the next cycle; short backoff so maybeAlertSkip path stays bounded too.
				// Rotate failed retries to the end of Map iteration order (starvation prevention — same as
				// the terminal loop above). Without rotation, five permanently failing skip entries at the
				// front would starve every later pending skip page indefinitely under the per-cycle cap —
				// now plausible because deadline pages are keyed per minter.
				this.pendingSkipAlerts.delete(retentionKey);
				this.pendingSkipAlerts.set(retentionKey, body);
				this.lastSkipAlertAt[kind] = Date.now() - SKIP_ALERT_COOLDOWN_MS + SKIP_ALERT_RETRY_BACKOFF_MS;
				this.logger.error(`MinterGuard skip page retry failed delivery (key=${retentionKey}); retained for next cycle: ${body}`);
			}
		}

		// Aggregate backlog line, independent of whether the cap truncated the pass: a page attempted this
		// cycle that STILL failed (as opposed to never attempted) would otherwise leave no summary line at
		// all when the pending count is at or below the cap — a backlog must never be invisible.
		// Individual failures keep their own log line from deliverTerminalAlert / skip retry.
		// Include undelivered skip pages so the log names the true number of undelivered pages.
		let stillPendingAfter = 0;
		for (const state of this.denyState.values()) {
			if (state.pendingAlert && state.alerted !== true) stillPendingAfter++;
		}
		stillPendingAfter += this.pendingSkipAlerts.size;
		if (stillPendingAfter > 0) {
			this.logger.warn(
				`MinterGuard: ${stillPendingAfter} pending page(s) still awaiting delivery after this cycle's retry pass ` +
					`(terminal + skip)`
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

		// Single cycle deadline: every RPC-bearing pass and per-tx wait derives stop/timeout from this
		// (see CYCLE_BUDGET_MS / cycleRemainingMs). Captured once at the start of the guard work.
		const cycleStartedAt = Date.now();

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

		// Registration is pure bookkeeping and must not depend on any chain call. Register every candidate
		// BEFORE the capped resolve pass so a failed minters() read or a candidate beyond the resolve cap
		// cannot leave an observed address untracked. This is what makes the end-of-cycle invariant hold by
		// construction — nothing that can fail may come before it. Do not touch an existing entry
		// (attempts/done/pendingAlert must survive).
		for (const minter of candidates) {
			const addrLc = minter.address.toLowerCase();
			if (this.denyState.get(addrLc) === undefined) {
				this.denyState.set(addrLc, { attempts: 0 });
			}
		}

		// Sort by the deadline derivable WITHOUT a chain call (applicationTimestamp + applicationPeriod from
		// the repository row), ascending, BEFORE applying the resolve cap. The on-chain read stays
		// authoritative for the deny decision; this ordering only decides who gets examined first, so the
		// most urgent veto window can no longer be stranded behind the resolve cap.
		const candidatesOrdered = [...candidates].sort((a, b) => {
			const deadlineA = a.applicationTimestamp + a.applicationPeriod;
			const deadlineB = b.applicationTimestamp + b.applicationPeriod;
			return deadlineA < deadlineB ? -1 : deadlineA > deadlineB ? 1 : 0;
		});

		// Resolve pass BEFORE pre-check: filter already-resolved minters, order by urgency, and give the
		// pre-check an honest actionable candidate count. Deadlines read here are NOT authoritative for the
		// send — the mapping can change while the cycle runs (another actor may deny mid-loop); the send
		// loop re-reads minters(address) immediately before each deny (see send loop).
		const workingSet: ResolvedCandidate[] = [];
		if (candidatesOrdered.length > 0) {
			this.logger.warn(`Found ${candidatesOrdered.length} unwhitelisted PROPOSED minter(s) to deny`);

			let resolveReads = 0;
			let resolveTruncated = false;
			let resolveStopReason: 'count' | 'time' | undefined;
			for (const minter of candidatesOrdered) {
				// Cap serial RPC by count AND the single cycle deadline so this pass cannot outgrow the
				// 5-minute cadence (see MAX_RESOLVE_READS_PER_CYCLE and CYCLE_BUDGET_MS).
				if (resolveReads >= MAX_RESOLVE_READS_PER_CYCLE) {
					resolveTruncated = true;
					resolveStopReason = 'count';
					break;
				}
				if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
					resolveTruncated = true;
					resolveStopReason = 'time';
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
					// Candidate is already registered above; drop from workingSet for this cycle only.
					// Pass address as dedupKey so a retained deadline page for one minter cannot be destroyed
					// when a later same-kind page for a different minter is delivered or retained.
					const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
					this.logger.error(`MinterGuard skip ${address}: failed to read on-chain deny deadline (minters): ${errorMsg}`);
					await this.maybeAlertSkip(
						'deadline',
						`⚠️ *Minter guard could not read deny deadline*\n\n` +
							`Address: \`${address}\`\n` +
							`Detail: ${escapeMarkdownText(errorMsg)}\n\n` +
							`The on-chain application deadline could not be read this cycle; the candidate is deferred ` +
							`(not marked done). Investigate RPC if this persists — a silent window expiry must not happen.`,
						address
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
				// Already registered before any RPC (see loop above). Entry is present for the sweep even if
				// this candidate later hits a continue path (cycle-budget deferral, getBlock failure).
				workingSet.push({ address, onChainDeadline });
			}
			if (resolveTruncated) {
				const notExamined = candidatesOrdered.length - resolveReads;
				const limitDesc =
					resolveStopReason === 'time'
						? `cycle deadline ${CYCLE_BUDGET_MS}ms`
						: `count cap ${MAX_RESOLVE_READS_PER_CYCLE} minters() reads`;
				this.logger.warn(
					`MinterGuard: resolve pass stopped (${limitDesc}); ` +
						`${notExamined} candidate(s) not examined this cycle (truncated — not a completed pass)`
				);
			}
		}

		// Nothing actionable: skip pre-check (would page "N left undenied" about minters that need nothing).
		if (workingSet.length > 0) {
			// Urgency, not database order, must decide when the cycle budget runs short: serve the
			// soonest veto window first.
			workingSet.sort((a, b) => (a.onChainDeadline < b.onChainDeadline ? -1 : a.onChainDeadline > b.onChainDeadline ? 1 : 0));

			// Signer-global pre-check (once per cycle, before any deny): verify quorum + gas and build helpers.
			// Count is the number of genuinely actionable minters after the resolve pass.
			const precheck = await this.runDenyPrecheck(signerAddress, wallet, workingSet, cycleStartedAt);
			if (precheck.ok) {
				const helpers = precheck.helpers;

				let deferDeniesLogged = false;
				let candidatesStarted = 0;

				for (const { address, onChainDeadline: resolveDeadline } of workingSet) {
					// Cycle-deadline guard BEFORE the two just-in-time reads — distinct from the send-budget
					// gate further down (that one still allows diagnostics when confirmation-wait budget is
					// too small; this one refuses to start either read once the cycle is already over budget).
					// Bound: the loop can still overshoot the cycle deadline by at most one in-flight read
					// (same as the resolve pass); an outstanding RPC cannot be cancelled, so the deadline is
					// meaningful rather than exact.
					if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
						const remaining = workingSet.length - candidatesStarted;
						this.logger.warn(
							`MinterGuard: cycle deadline reached before deny-candidate JIT reads; ` +
								`${remaining} remaining candidate(s) not examined this cycle ` +
								`(not marked done, no page — deferred to next cycle).`
						);
						break;
					}
					candidatesStarted++;

					const addrLc = address.toLowerCase();

					// Just-in-time TooLate / already-resolved guard. denyMinter reverts TooLate once
					// block.timestamp > minters[_minter]. Re-read BOTH the live block timestamp and the
					// on-chain deadline immediately before send: the resolve-pass deadline is stale once
					// another actor denies mid-cycle (mapping deleted → 0) while we wait on a previous
					// candidate's confirmation. Sending with a stale deadline reverts, marks the minter
					// permanently failed, and pages "manual denyMinter() required" for a minter already denied.
					// currentDeadline is the authoritative value for buffer comparison and windowClosed text.
					//
					// These cheap diagnostics run BEFORE the send-budget gate: the working set is sorted
					// soonest-deadline-first, so a candidate whose window is closing right now must still
					// be recorded and paged ("passing unchallenged") even when remaining budget is too
					// small to send. Deferring before these reads would silently drop the most urgent
					// candidate — the failure this ordering prevents.
					// Entry was registered BEFORE the resolve pass (RPC-free bookkeeping at the start of
					// checkAndDeny) so a resolve-pass failure or timeout cannot leave a candidate untracked —
					// the sweep still sees this deferred minter.
					let latestBlock: ethers.Block | null = null;
					let currentDeadline: bigint;
					try {
						latestBlock = await this.providerService.provider.getBlock('latest');
						// Same cycle-deadline discipline as the top-of-loop guard: a single slow getBlock must
						// not be compounded by a second minters() read once the budget is already gone.
						if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
							this.logger.warn(
								`MinterGuard skip ${address}: cycle deadline reached between getBlock and minters() ` +
									`(not marked done, no page — deferred to next cycle)`
							);
							continue;
						}
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

					// Gate on SENDING, not on the candidate: remaining cycle budget too small for a useful
					// confirmation wait — defer the deny (not fail) so the sweep and pending-alert retry still
					// run and the next cycle can finish the rest. Do not mark done; do not page. Candidate
					// stays tracked and is actionable again next cycle. Diagnostics above already ran.
					const remainingBudgetMs = this.cycleRemainingMs(cycleStartedAt);
					if (remainingBudgetMs < DENY_CONFIRM_MIN_USEFUL_MS) {
						if (!deferDeniesLogged) {
							this.logger.warn(
								`MinterGuard: cycle budget exhausted (${CYCLE_BUDGET_MS - remainingBudgetMs}ms spent of ` +
									`${CYCLE_BUDGET_MS}ms); deferring remaining deny send(s) including ${address} ` +
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
					// Per-tx wait capped by whatever is left of the cycle deadline, so a slow confirmation
					// cannot push the cycle past the cadence.
					// INVARIANT: the send-budget gate above guarantees remainingBudgetMs >= DENY_CONFIRM_MIN_USEFUL_MS
					// at this point, so waitTimeoutMs is always positive. A non-positive timeout must never be
					// submitted: ethers passes it to setTimeout, Node clamps it to ~1 ms, tx.wait rejects almost
					// immediately after the tx is already in-flight — burning a MAX_DENY_ATTEMPTS slot and risking
					// a redundant fresh-nonce resend for a deny that may confirm on its own.
					const waitTimeoutMs = Math.min(DENY_CONFIRM_TIMEOUT_MS, this.cycleRemainingMs(cycleStartedAt));
					try {
						const tx = await juiceDollar.denyMinter(address, helpers, message);
						txHash = tx.hash;
						this.logger.warn(`Submitted denyMinter for ${address}: tx=${tx.hash}`);
						// Bounded wait within the cycle deadline: on timeout this throws and the minter is
						// left unmarked to retry next cycle. A retry sends a fresh-nonce tx (it does not
						// replace a stuck one); under sustained mempool/gas pathology the deny may not land, but the
						// terminal FAILED alert then pages a human — an accepted limitation of the opt-in guard,
						// deliberately not carrying nonce/replacement state.
						const receipt: ethers.ContractTransactionReceipt | null = await tx.wait(1, waitTimeoutMs);
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
						const delivered = await this.telegramService.sendCriticalAlert(truncateAlertBody(successMsg));
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
							// Re-read the mapping before claiming manual action is needed: another actor may have
							// denied the minter between pre-send and this catch (TooLate / mapping 0). A false
							// "manual denyMinter() required" page erodes trust in every other page the guard sends.
							if (done && !prev.alerted) {
								let deadlineForRemedy = currentDeadline;
								let recheckNote = '';
								try {
									const freshDeadline = BigInt(await juiceDollar.minters(address));
									if (freshDeadline === 0n) {
										// Resolved by someone else — mark done, send NO page.
										this.denyState.set(addrLc, { ...next, done: true });
										this.logger.warn(
											`MinterGuard: deny failed for ${address} but on-chain minters(address)=0 ` +
												`(resolved by another actor); no manual-action page`
										);
										continue;
									}
									deadlineForRemedy = freshDeadline;
								} catch (recheckError) {
									// A read failure here must not lose the page: fall back to the pre-send value and
									// say in the message that the on-chain state could not be re-checked.
									const recheckMsg =
										typeof recheckError?.message === 'string' && recheckError.message
											? recheckError.message
											: String(recheckError);
									this.logger.error(
										`MinterGuard: could not re-check on-chain state for ${address} after deny failure: ${recheckMsg}`
									);
									recheckNote =
										' On-chain state could not be re-checked after the failure; remedy text uses the pre-send deadline.';
								}
								// Chain clock and contract comparison only: denyMinter gates on
								// block.timestamp > minters[_minter]. Local Date.now() skew or >= would let the
								// remedy text contradict what the contract would still accept.
								const windowClosed = BigInt(latestBlock.timestamp) > deadlineForRemedy;
								const remedy = windowClosed
									? 'The application period has ended — denyMinter is impossible; challenge/handle the minter otherwise if needed.'
									: 'Manual denyMinter() required before the application period ends.';
								const alertMsg =
									`⚠️ *Minter auto-deny FAILED*\n\n` +
									`Address: \`${address}\`\n` +
									`Class: ${escapeMarkdownText(classification.label)} (${classification.kind})\n` +
									`Detail: ${escapeMarkdownText(classification.detail)}\n` +
									`Attempts: ${attempts}/${MAX_DENY_ATTEMPTS}\n\n` +
									remedy +
									recheckNote;
								await this.deliverTerminalAlert(addrLc, { ...next, done: true }, alertMsg);
							}
						}
					}
				}
			}
		}

		// Sweep tracked minters that left the PROPOSED candidate set without a deny (see method).
		// Still runs after a send-loop deferral (cheap, prevents silent pass-through) but respects the deadline.
		await this.sweepPassedUnchallenged(juiceDollar, candidateAddressSet, cycleStartedAt);

		// Pending terminal pages after deny work — notifications are not time-critical; a veto window is.
		// Still runs after a deferral; also respects the cycle deadline.
		await this.retryPendingAlerts(cycleStartedAt);

		// INVARIANT: every address OBSERVED this cycle (candidateAddressSet, built from the PROPOSED /
		// non-whitelisted / not-yet-done query above) must hold a denyState entry by now — "observation
		// implies tracking". Registration of every candidate happens BEFORE any RPC (pure bookkeeping), so
		// this assertion can no longer fire for a capped resolve pass or a failed minters() read — it fires
		// only on a genuine code defect (some path still drops a candidate without recording it). Three
		// earlier review rounds found the silent pass-through class (observed but never tracked, then
		// invisible to sweepPassedUnchallenged once syncMinters relabels it APPROVED); fail loud rather than
		// patch a fourth time if bookkeeping is ever broken again.
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
	 * Read count is capped (MAX_SWEEP_READS_PER_CYCLE) and wall-clock is the single cycle deadline
	 * (CYCLE_BUDGET_MS via cycleRemainingMs) so serial minters() calls cannot stretch a cycle past the
	 * 5-minute cadence — a count cap alone does not stop sequential RPC timeouts from overrunning.
	 * Resume is round-robin via sweepResumeAfter: with a fixed start, entries beyond the cap would never
	 * be examined again.
	 */
	private async sweepPassedUnchallenged(
		juiceDollar: ethers.Contract,
		candidateAddresses: Set<string>,
		cycleStartedAt: number
	): Promise<void> {
		// Honour the single cycle deadline BEFORE the initial getBlock so the sweep cannot start work
		// it has no time for (the cycle-wide invariant: every pass derives remaining time from the
		// deadline). Mid-pass deadline checks below still stop further minters() reads.
		if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
			this.logger.warn(`MinterGuard: sweep skipped (cycle deadline ${CYCLE_BUDGET_MS}ms); no tracked minters examined this cycle`);
			return;
		}

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
		let sweepStopReason: 'count' | 'time' | undefined;
		// Eligible keys we walked past without a minters() read (done / still-candidate) do not count
		// toward the read cap; only actual RPC reads do. Cycle deadline is checked at the same point.
		for (let i = 0; i < keys.length; i++) {
			const addrLc = keys[(startIdx + i) % keys.length];
			const state = this.denyState.get(addrLc);
			// Entry may have been removed (unlikely) or already marked done earlier in this pass.
			if (!state || state.done) continue;
			// Still in this cycle's candidate set — handled by the normal deny path.
			if (candidateAddresses.has(addrLc)) continue;

			if (sweepReads >= MAX_SWEEP_READS_PER_CYCLE) {
				truncated = true;
				sweepStopReason = 'count';
				break;
			}
			if (this.cycleRemainingMs(cycleStartedAt) <= 0) {
				truncated = true;
				sweepStopReason = 'time';
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
			const limitDesc =
				sweepStopReason === 'time'
					? `cycle deadline ${CYCLE_BUDGET_MS}ms`
					: `count cap ${MAX_SWEEP_READS_PER_CYCLE} minters() reads`;
			this.logger.warn(
				`MinterGuard: sweep stopped (${limitDesc}); ` +
					`${notExamined} tracked minter(s) not examined this cycle (truncated — not a completed pass)`
			);
		}
	}

	/**
	 * Signer-global deny pre-check, run once per cycle before any denyMinter(). Returns { ok, helpers }:
	 *   - ok=true  => helpers are ready; proceed to per-candidate deny loop.
	 *   - ok=false => SKIP all denies this cycle. Paths that produce ok=false:
	 *       * cycle budget already below DENY_CONFIRM_MIN_USEFUL_MS at entry — defer (warn, no page),
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
		candidates: Array<{ address: string }>,
		cycleStartedAt: number
	): Promise<{ ok: boolean; helpers: string[] }> {
		// Honour the single cycle deadline before any pre-check RPC: if remaining budget is below the
		// useful floor there is no point starting sequential votes/gas calls we cannot finish, and the
		// send loop would only defer anyway. Deferral is not a failure — candidates stay tracked/unmarked,
		// no page (a missed cycle of pre-check is recovered next tick).
		const precheckRemainingMs = this.cycleRemainingMs(cycleStartedAt);
		if (precheckRemainingMs < DENY_CONFIRM_MIN_USEFUL_MS) {
			this.logger.warn(
				`MinterGuard: deny pre-check deferred (cycle deadline ${CYCLE_BUDGET_MS}ms; ` +
					`${precheckRemainingMs}ms remaining < ${DENY_CONFIRM_MIN_USEFUL_MS}ms useful floor); ` +
					`${candidates.length} candidate(s) left for the next cycle (not marked done, no page — deferral is not a failure).`
			);
			return { ok: false, helpers: [] };
		}

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
			// balance against a helper-count-aware worst-case ceiling (denyGasCeiling * fee) up front
			// guarantees a gas shortfall ALWAYS pages, before estimateGas is ever attempted. helpers.length
			// is the post seed-drop-retry set. Native unit on Citrea is cBTC (18 decimals —
			// ethers.formatEther is still correct).
			const worstCaseCost = denyGasCeiling(helpers.length) * gasPrice;
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
			// order), only after the balance floor above rules out an obvious "insufficient funds" shortfall
			// and after the votes check rules out a NotQualified revert. The floor catches an obviously
			// underfunded signer up front; it does NOT guarantee the true cost — the band between the
			// permissive worst-case floor and the real estimate is what estimateGas covers next.
			//
			// Split on estimate failure:
			//   * insufficient funds (code or message) → gas shortfall in that band: page and skip the cycle
			//     (same dedicated gas page the floor-before-estimate ordering exists to guarantee). Without
			//     this branch the catch would swallow the shortfall, the cycle would proceed, and the real
			//     send would fail as an ordinary per-candidate error instead of the gas page.
			//   * any other estimate revert → BEST-EFFORT: a sample-specific revert must NOT drop every
			//     candidate this cycle (e.g. sample just crossed its own deadline). Proceed on the floor;
			//     the per-candidate TooLate guard + try/catch handle each send.
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
				const isInsufficientFunds = estimateError?.code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(em);
				if (isInsufficientFunds) {
					// Narrow band between the worst-case floor and true cost: floor passed, estimate did not.
					this.logger.warn(
						`MinterGuard SKIP: signer ${signerAddress} low on gas ` +
							`(balance ${ethers.formatEther(balance)} cBTC; precise estimate reported insufficient funds: ${em})`
					);
					await this.maybeAlertSkip(
						'gas',
						`⚠️ *Minter guard low on cBTC — deny skipped*\n\n` +
							`Signer: \`${signerAddress}\`\n` +
							`Balance: ${ethers.formatEther(balance)} cBTC\n` +
							`Precise estimate reported insufficient funds.\n` +
							`${candidates.length} unwhitelisted PROPOSED minter(s) left undenied.\n\n` +
							`Fund the signer with cBTC.`
					);
					return { ok: false, helpers };
				}
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
	 * COOLDOWN stays per kind — it limits how often a CLASS of page fires. Retention and retry are per
	 * page: optional dedupKey keys pendingSkipAlerts as `${kind}:${dedupKey}` so a per-candidate page
	 * (e.g. deadline for minter A) is not overwritten or deleted when a later same-kind page for a
	 * different minter is retained or delivered. Cycle-global pages (votes, gas, seed, precheck,
	 * invariant) omit dedupKey and stay keyed by kind alone. Do not conflate the two bookkeeping axes.
	 *
	 * Cooldown arming:
	 *   - SUCCESS (or telegram disabled): stamp full SKIP_ALERT_COOLDOWN_MS — a delivered page must not
	 *     be repeated for an hour. Clear any retained undelivered body for this page key.
	 *   - FAILED delivery: stamp a short SKIP_ALERT_RETRY_BACKOFF_MS window AND retain the truncated body
	 *     in pendingSkipAlerts so retryPendingAlerts can re-send even if the condition does not recur
	 *     (candidate became APPROVED, RPC recovered). A page describing a condition that no longer holds
	 *     is still worth delivering: it tells the operator what happened while they could not be reached.
	 * Trade-off explicit: delivered → quiet for an hour; failed → bounded retry + retention; never a per-cycle loop.
	 */
	private async maybeAlertSkip(kind: SkipAlertKind, message: string, dedupKey?: string): Promise<void> {
		const nowMs = Date.now();
		const lastAt = this.lastSkipAlertAt[kind];
		if (nowMs - lastAt < SKIP_ALERT_COOLDOWN_MS) return;

		// Retention key is per page; cooldown above is still per kind (see method comment).
		const retentionKey = dedupKey ? `${kind}:${dedupKey}` : kind;

		// Truncate every skip-page body too — not just terminal pages (see truncateAlertBody).
		const body = truncateAlertBody(message);

		// Telegram disabled: nothing to deliver to — stamp full cooldown so we do not re-log every cycle.
		if (!this.telegramService.alertsEnabled) {
			this.lastSkipAlertAt[kind] = nowMs;
			this.pendingSkipAlerts.delete(retentionKey);
			this.logger.error(`MinterGuard skip page not deliverable (telegram disabled): ${body}`);
			return;
		}

		const delivered = await this.telegramService.sendCriticalAlert(body);
		if (delivered) {
			this.lastSkipAlertAt[kind] = nowMs;
			this.pendingSkipAlerts.delete(retentionKey);
		} else {
			// Short backoff only: next attempt after SKIP_ALERT_RETRY_BACKOFF_MS (see method comment).
			// lastAt is stored such that (now - lastAt) reaches SKIP_ALERT_COOLDOWN_MS after the backoff.
			// Retain the truncated body so the page is not lost when the condition stops recurring.
			this.lastSkipAlertAt[kind] = nowMs - SKIP_ALERT_COOLDOWN_MS + SKIP_ALERT_RETRY_BACKOFF_MS;
			this.pendingSkipAlerts.set(retentionKey, body);
			this.logger.error(
				`MinterGuard skip page failed delivery (key=${retentionKey}); retained and will retry after ` +
					`${SKIP_ALERT_RETRY_BACKOFF_MS}ms backoff: ${body}`
			);
		}
	}

	/**
	 * Remaining wall-clock budget for the current guard cycle (see CYCLE_BUDGET_MS). Every RPC-bearing
	 * pass, the send-loop stop condition, and each per-tx wait timeout derive from this single deadline
	 * so an overrun cannot leave isRunning stuck across the next EVERY_5_MINUTES tick.
	 */
	private cycleRemainingMs(cycleStartedAt: number): number {
		return CYCLE_BUDGET_MS - (Date.now() - cycleStartedAt);
	}

	/**
	 * Qualification half of GET /guard (and the startup probe): helper derivation, votesDelegated verdict
	 * with seed-less retry, NoRevertData rethrow, and additive display fallback only when the contract
	 * rejected the helper list.
	 *
	 * When votesDelegated answers: that number is both votingPower (for votingPowerPct) and the qualified
	 * verdict. totalVotes and votesDelegated come from two sequential contract view reads (not Multicall3 —
	 * this deployment has none; multicallProvider is the plain provider). Reading both from the contract
	 * removes the earlier additive-vs-contract mismatch, but the pair is not atomic: a transfer between
	 * the two reads can still shift the ratio slightly. An additive votes() sum is ONLY an estimate when
	 * the contract refused (qualified is then false anyway) — never a second live path that can disagree
	 * with the verdict after a helper moved equity between calls.
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
			// Sequential contract views (not atomic; see method doc) — both from the contract so the
			// ratio matches on-chain checkQualified rather than an additive votes() estimate.
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

		// Gas status: model denyMinter() cost with the helper-count-aware ceiling * live fee.
		const balance: bigint = await provider.getBalance(signerAddress);
		const feeData = await provider.getFeeData();
		const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
		if (gasPrice === null || gasPrice === undefined) throw new Error('feeData has neither maxFeePerGas nor gasPrice');
		const estimatedDenyCost = denyGasCeiling(qual.helperCount) * gasPrice;

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
