import { Injectable, Logger } from '@nestjs/common';
import { PositionOpenedEvent, PositionState } from './types';
import { AppConfigService } from '../config/config.service';
import { PositionV2ABI, MintingHubV2ABI, ADDRESS, ERC20ABI } from '@juicedollar/jusd';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { PositionRepository } from './prisma/repositories/position.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TokenRepository } from './prisma/repositories/token.repository';
import { TelegramService } from './telegram.service';
import { PriceService } from './price.service';

// Anything below is suspicious for a clone.
const MINI_LIFETIME_THRESHOLD_SECONDS = 86_400n; // 1 day
const EXPIRING_SOON_WINDOW_SECONDS = 86_400n; // 24 h heads-up before expiration
const TELEGRAM_THROTTLE_MS = 100; // stay under per-chat rate limit (~30 msg/s) when bursting

// Liq-price sanity-check thresholds. Conservative on purpose — false positives are cheap
// during the 3-day init period; missed alerts are not.
const LIQ_PRICE_OVER_SPOT_RATIO = 2.0; // virtualPrice / coingecko spot above this is suspicious
const MIN_POSITION_VALUE_JUSD = 500n * 10n ** 18n; // V3 hardcodes this floor; V2 does not
const CHALLENGER_REWARD_PPM = 20_000; // 2% — matches MintingHub's hardcoded constant

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PositionService {
	private readonly logger = new Logger(PositionService.name);
	private existingPositions = new Set<string>(); // Just track addresses

	constructor(
		private readonly config: AppConfigService,
		private readonly positionRepo: PositionRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly providerService: ProviderService,
		private readonly tokenRepo: TokenRepository,
		private readonly priceService: PriceService
	) {}

	async initialize(): Promise<void> {
		const addresses = await this.positionRepo.findAddresses();
		this.existingPositions = new Set(addresses.map((a) => a.toLowerCase()));
		this.logger.log(`Loaded ${this.existingPositions.size} existing positions`);
	}

	async syncPositions(): Promise<void> {
		const positionOpenedArgs = await this.eventsRepo.getPositions();
		if (positionOpenedArgs.length === 0) return;

		// Fetch on-chain data
		const positionStates = await this.fetchPositionData(positionOpenedArgs);

		// Persist
		const newStates = positionStates.filter((p) => p.limit !== undefined);
		const existingStates = positionStates.filter((p) => p.limit === undefined);
		if (newStates.length > 0) await this.positionRepo.createMany(newStates);
		if (existingStates.length > 0) await this.positionRepo.updateMany(existingStates);

		// Update cache
		for (const position of positionStates) this.existingPositions.add(position.address.toLowerCase());
		this.logger.log(`Successfully synced ${positionStates.length} position states`);
	}

	private async fetchPositionData(positionOpenedArgs: PositionOpenedEvent[]): Promise<Partial<PositionState>[]> {
		const multicallProvider = this.providerService.multicallProvider;
		const mintingHub = new ethers.Contract(ADDRESS[this.config.blockchainId].mintingHubGateway, MintingHubV2ABI, multicallProvider);

		const deniedPositions = await this.eventsRepo.getDeniedPositions();

		const calls: Array<() => Promise<any>> = [];
		for (const event of positionOpenedArgs) {
			const address = event.address.toLowerCase();
			const isNew = !this.existingPositions.has(address);
			const position = new ethers.Contract(address, PositionV2ABI, multicallProvider);
			const collateralToken = new ethers.Contract(event.collateral, ERC20ABI, multicallProvider);

			// Fixed fields
			if (isNew) {
				calls.push(() => position.limit());
				calls.push(() => position.owner());
				calls.push(() => position.original());
				calls.push(() => position.collateral());
				calls.push(() => position.minimumCollateral());
				calls.push(() => position.riskPremiumPPM());
				calls.push(() => position.reserveContribution());
				calls.push(() => position.challengePeriod());
				calls.push(() => position.start());
				calls.push(() => position.expiration());
			}

			// Dynamic fields
			calls.push(() => position.price());
			calls.push(() => position.virtualPrice());
			calls.push(() => position.getCollateralRequirement());
			calls.push(() => position.principal());
			calls.push(() => position.getInterest());
			calls.push(() => position.getDebt());
			calls.push(() => position.fixedAnnualRatePPM());
			calls.push(() => position.lastAccrual());
			calls.push(() => position.cooldown());
			calls.push(() => position.challengedAmount());
			calls.push(() => position.availableForMinting());
			calls.push(() => position.availableForClones());
			calls.push(() => position.isClosed());
			calls.push(() => mintingHub.expiredPurchasePrice(address));
			calls.push(() => collateralToken.balanceOf(address));
		}

		const responses = await this.providerService.callBatch(calls, 3);

		let idx = 0;
		const results: Partial<PositionState>[] = [];
		for (const event of positionOpenedArgs) {
			const address = event.address.toLowerCase();
			const isNew = !this.existingPositions.has(address);

			const state: Partial<PositionState> = {
				address,
				timestamp: new Date(),
			};

			if (isNew) {
				// Fixed fields
				state.limit = BigInt(responses[idx++]);
				state.owner = responses[idx++];
				state.original = responses[idx++];
				state.collateral = responses[idx++];
				state.minimumCollateral = BigInt(responses[idx++]);
				state.riskPremiumPpm = Number(responses[idx++]);
				state.reserveContribution = Number(responses[idx++]);
				state.challengePeriod = BigInt(responses[idx++]);
				state.startTimestamp = BigInt(responses[idx++]);
				state.expiration = BigInt(responses[idx++]);
				state.created = event.timestamp;
			}

			// Dynamic fields
			state.price = BigInt(responses[idx++]);
			state.virtualPrice = BigInt(responses[idx++]);
			state.collateralRequirement = BigInt(responses[idx++]);
			state.principal = BigInt(responses[idx++]);
			state.interest = BigInt(responses[idx++]);
			state.debt = BigInt(responses[idx++]);
			state.fixedAnnualRatePpm = Number(responses[idx++]);
			state.lastAccrual = BigInt(responses[idx++]);
			state.cooldown = BigInt(responses[idx++]);
			state.challengedAmount = BigInt(responses[idx++]);
			state.availableForMinting = BigInt(responses[idx++]);
			state.availableForClones = BigInt(responses[idx++]);
			state.isClosed = Boolean(responses[idx++]);
			state.expiredPurchasePrice = BigInt(responses[idx++]);
			state.collateralAmount = BigInt(responses[idx++]);
			state.isDenied = deniedPositions.includes(address);

			results.push(state);
		}

		this.logger.log(`Fetched position data for ${results.length} positions via multicall`);
		return results;
	}

	/**
	 * Detect newly created positions whose (expiration - created) is below the mini-lifetime threshold.
	 * Sub-day lifetime is a known forced-sale attack pattern (the WFPS attacker on the dEURO side
	 * used a 36-second clone) — fires a HIGH-severity alert ~5 minutes after such a clone is created.
	 */
	async checkMiniLifetimeClones(telegramService: TelegramService): Promise<void> {
		const candidates = await this.positionRepo.findUnalertedMiniLifetime(MINI_LIFETIME_THRESHOLD_SECONDS);
		if (candidates.length === 0) return;

		const now = BigInt(Math.floor(Date.now() / 1000));
		for (const c of candidates) {
			const lifetime = c.expiration - c.created;
			const principalJusd = formatJusd(c.principal);
			const message =
				`Suspicious clone detected\n\n` +
				`Position: \`${c.address}\`\n` +
				`Owner: \`${c.owner}\`\n` +
				`Collateral: \`${c.collateral}\`\n` +
				`Lifetime: *${lifetime}s*  (threshold: ${MINI_LIFETIME_THRESHOLD_SECONDS}s)\n` +
				`Principal: ${principalJusd} JUSD\n\n` +
				`This pattern matches the forced-sale attack vector (clone with sub-day lifetime, ` +
				`waiting for decay to drain the equity reserve).\n\n` +
				`Mitigation: open a challenge or call \`buyExpiredCollateral\` once the position enters phase 2.\n\n` +
				`[Citreascan](https://citreascan.com/address/${c.address})`;

			const delivered = await telegramService.sendCriticalAlert(message);
			if (delivered) {
				await this.positionRepo.markMiniLifetimeAlerted(c.address, now);
				this.logger.warn(`Mini-lifetime alert sent for ${c.address} (lifetime=${lifetime}s)`);
			}
			await sleep(TELEGRAM_THROTTLE_MS);
		}
	}

	/**
	 * Detect open positions whose expiration is within the next EXPIRING_SOON_WINDOW. One alert
	 * per position via expiring_soon_alerted_at.
	 */
	async checkExpiringSoon(telegramService: TelegramService): Promise<void> {
		const now = BigInt(Math.floor(Date.now() / 1000));
		const candidates = await this.positionRepo.findUnalertedExpiringSoon(now + EXPIRING_SOON_WINDOW_SECONDS);
		if (candidates.length === 0) return;

		for (const c of candidates) {
			const principalJusd = formatJusd(c.principal);
			const hoursToExpiration = Number(c.expiration - now) / 3600;
			const message =
				`Position will expire soon\n\n` +
				`Position: \`${c.address}\`\n` +
				`Owner: \`${c.owner}\`\n` +
				`Collateral: \`${c.collateral}\`\n` +
				`Principal: ${principalJusd} JUSD\n` +
				`Expires in: ${hoursToExpiration.toFixed(1)} hours\n` +
				`Challenge period: ${Number(c.challengePeriod) / 3600} hours\n\n` +
				`Forced-sale window opens at expiration. Plan to monitor and intervene during ` +
				`phase 2 (after one challenge period) if needed.\n\n` +
				`[Citreascan](https://citreascan.com/address/${c.address})`;

			const delivered = await telegramService.sendCriticalAlert(message);
			if (delivered) {
				await this.positionRepo.markExpiringSoonAlerted(c.address, now);
				this.logger.warn(`Expiring-soon alert sent for ${c.address}`);
			}
			await sleep(TELEGRAM_THROTTLE_MS);
		}
	}

	/**
	 * Detect open positions that just transitioned past expiration with positive debt. Fires once
	 * per position via expired_alerted_at; the phase-2 watcher takes over after one challenge period.
	 */
	async checkExpired(telegramService: TelegramService): Promise<void> {
		const now = BigInt(Math.floor(Date.now() / 1000));
		const expired = await this.positionRepo.findUnalertedExpired(now);
		if (expired.length === 0) return;

		for (const p of expired) {
			// If a position is first seen already in phase 2 (e.g. service was down longer
			// than one challengePeriod past expiration), skip the expired alert — the phase-2
			// watcher fires in the same cycle with more actionable info.
			if (now - p.expiration >= p.challengePeriod) {
				await this.positionRepo.markExpiredAlerted(p.address, now);
				continue;
			}
			const principalJusd = formatJusd(p.principal);
			const begin = new Date(Number(p.expiration) * 1000);
			const phase2Start = new Date(Number(p.expiration + p.challengePeriod) * 1000);
			const decayEnd = new Date(Number(p.expiration + p.challengePeriod * 2n) * 1000);

			const message =
				`Position is expired — forced-sale window open\n\n` +
				`Position: \`${p.address}\`\n` +
				`Owner: \`${p.owner}\`\n` +
				`Collateral: \`${p.collateral}\`\n` +
				`Principal: ${principalJusd} JUSD\n\n` +
				`Decay schedule (\`expiredPurchasePrice\`):\n` +
				`• 10× → 1× liq-price: ${begin.toUTCString()}\n` +
				`• 1× → 0× liq-price:  ${phase2Start.toUTCString()}\n` +
				`• Reaches zero:        ${decayEnd.toUTCString()}\n\n` +
				`Phase 2 (1× → 0×) is the actionable arbitrage window. ` +
				`A defender can call \`MintingHub.buyExpiredCollateral\` to repay the debt at decay price.\n\n` +
				`[Citreascan](https://citreascan.com/address/${p.address})`;

			const delivered = await telegramService.sendCriticalAlert(message);
			if (delivered) {
				await this.positionRepo.markExpiredAlerted(p.address, now);
				this.logger.warn(`Expired alert sent for ${p.address}`);
			}
			await sleep(TELEGRAM_THROTTLE_MS);
		}
	}

	/**
	 * Detect open positions that are past their expiration with positive debt and have entered
	 * phase 2 of the forced-sale decay (where price drops from 1× to 0× liq-price). Sends one
	 * HIGH-severity alert per position via the dedup column phase2_alerted_at.
	 */
	async checkExpiredInPhase2(telegramService: TelegramService): Promise<void> {
		const now = BigInt(Math.floor(Date.now() / 1000));
		const candidates = await this.positionRepo.findUnalertedPhase2(now);
		if (candidates.length === 0) return;

		for (const p of candidates) {
			const timePassed = now - p.expiration;
			if (timePassed < p.challengePeriod) continue; // still in phase 1 (price > liq)

			// In phase 2 — useful arbitrage window. Clamp progress at 100% in case the cycle
			// runs after both decay phases have fully elapsed (decay price = 0).
			const principalJusd = formatJusd(p.principal);
			const decayPrice = BigInt(p.expiredPurchasePrice);
			const liqPrice = BigInt(p.price);
			const decayPct = liqPrice > 0n ? Number((decayPrice * 10000n) / liqPrice) / 100 : 0;
			const rawPhase2Pct = Number(((timePassed - p.challengePeriod) * 100n) / p.challengePeriod);
			const phase2Pct = Math.min(rawPhase2Pct, 100);
			const phaseLabel = rawPhase2Pct >= 100 ? 'phase 2 complete (decay reached 0)' : `phase 2 progress: ${phase2Pct}%`;

			const message =
				`Expired position in forced-sale decay\n\n` +
				`Position: \`${p.address}\`\n` +
				`Owner: \`${p.owner}\`\n` +
				`Collateral: \`${p.collateral}\`\n` +
				`Principal: ${principalJusd} JUSD\n` +
				`Time past expiration: ${timePassed}s  (challengePeriod: ${p.challengePeriod}s)\n` +
				`${phaseLabel} — price decays linearly from liq to 0\n` +
				`Current decay price: ${decayPct.toFixed(2)}% of liq\n\n` +
				`Without intervention, the equity reserve covers the gap between forced-sale ` +
				`proceeds and outstanding principal. A defender can call ` +
				`\`MintingHub.buyExpiredCollateral\` now to repay the debt at decay price.\n\n` +
				`[Citreascan](https://citreascan.com/address/${p.address})`;

			const delivered = await telegramService.sendCriticalAlert(message);
			if (delivered) {
				await this.positionRepo.markPhase2Alerted(p.address, now);
				this.logger.warn(`Phase-2 alert sent for ${p.address} (timePassed=${timePassed}s)`);
			}
			await sleep(TELEGRAM_THROTTLE_MS);
		}
	}

	/**
	 * Detect open positions whose parameters indicate a likely abuse attempt — set up
	 * to drain the equity reserve via the forced-sale decay rather than to borrow legitimately.
	 *
	 * Three independent triggers (any one fires the alert):
	 *  1. Liq-price ≥ LIQ_PRICE_OVER_SPOT_RATIO × coingecko spot. Catches the 2026-04-27
	 *     pattern (on the dEURO side) where liq-price was ~1000× the real spot.
	 *  2. Position value (minimumCollateral × liq-price) below MIN_POSITION_VALUE_JUSD.
	 *     V3 hardcodes a 500-stable floor in MintingHub; V2 does not, so the watcher closes
	 *     the gap for V2 positions.
	 *  3. riskPremiumPPM == 0 AND reservePPM ≤ CHALLENGER_REWARD_PPM. Such a position
	 *     cannot be profitably challenged — the challenger reward exceeds the seizable
	 *     reserve — so legitimate borrowers don't pick this combination.
	 *
	 * Per-position dedup via suspicious_liq_price_alerted_at.
	 */
	async checkSuspiciousLiqPrice(telegramService: TelegramService): Promise<void> {
		const candidates = await this.positionRepo.findUnalertedSuspiciousLiqPrice();
		if (candidates.length === 0) return;

		const tokens = await this.tokenRepo.findAll();
		const decimalsByToken = new Map<string, number>();
		for (const t of tokens) {
			if (t.decimals !== undefined && t.decimals !== null) {
				decimalsByToken.set(t.address.toLowerCase(), Number(t.decimals));
			}
		}

		const collateralAddrs = [...new Set(candidates.map((c) => c.collateral.toLowerCase()))];
		const spotPrices = await this.priceService.getTokenPricesInUsd(collateralAddrs);

		const now = BigInt(Math.floor(Date.now() / 1000));
		for (const c of candidates) {
			const reasons: string[] = [];
			const collateralAddr = c.collateral.toLowerCase();
			const decimals = decimalsByToken.get(collateralAddr);
			const virtualPrice = BigInt(c.virtualPrice);
			const minimumCollateral = BigInt(c.minimumCollateral);

			// Trigger 1: liq-price vs coingecko spot ratio (only when both decimals and spot known).
			// virtualPrice is in (36 - collateralDecimals) decimals; format to JUSD per 1 collateral
			// unit before comparing with the USD spot (JUSD is USD-pegged).
			const spotUsdStr = spotPrices[collateralAddr];
			if (decimals !== undefined && spotUsdStr !== undefined) {
				const virtualPriceFormatted = Number(ethers.formatUnits(virtualPrice, 36 - decimals));
				const spotUsd = Number(spotUsdStr);
				if (spotUsd > 0 && virtualPriceFormatted / spotUsd >= LIQ_PRICE_OVER_SPOT_RATIO) {
					reasons.push(
						`liq-price ${virtualPriceFormatted.toLocaleString('en-US', { maximumFractionDigits: 2 })} ` +
							`JUSD/token is ${(virtualPriceFormatted / spotUsd).toFixed(1)}× the coingecko spot ` +
							`of ${spotUsd.toLocaleString('en-US', { maximumFractionDigits: 4 })} USD/token`
					);
				}
			}

			// Trigger 2: position face value below the 500-JUSD floor.
			// minimumCollateral × virtualPrice / 1e18 collapses the (collateralDecimals + 36 - collateralDecimals)
			// product back down to 18-decimal JUSD regardless of token decimals.
			const positionValue = (minimumCollateral * virtualPrice) / 10n ** 18n;
			if (positionValue < MIN_POSITION_VALUE_JUSD) {
				reasons.push(
					`min-collateral × liq-price = ${formatJusd(positionValue.toString())} JUSD ` +
						`(below the V3-enforced floor of 500 JUSD)`
				);
			}

			// Trigger 3: zero risk premium plus reserve not even covering the challenger reward —
			// position is structured so it cannot be profitably challenged.
			if (c.riskPremiumPpm === 0 && c.reserveContribution <= CHALLENGER_REWARD_PPM) {
				reasons.push(
					`riskPremiumPPM=0 and reservePPM=${c.reserveContribution} ≤ challenger reward ` +
						`(${CHALLENGER_REWARD_PPM}); position cannot be profitably challenged`
				);
			}

			if (reasons.length === 0) continue;

			const message =
				`Suspicious position parameters\n\n` +
				`Position: \`${c.address}\`\n` +
				`Owner: \`${c.owner}\`\n` +
				`Collateral: \`${c.collateral}\`\n\n` +
				`Triggers:\n${reasons.map((r) => `• ${r}`).join('\n')}\n\n` +
				`Set-up matches the pattern of equity-drain attempts (liq-price miscalibrated ` +
				`relative to spot, micro-collateral, or unchallengeable parameters). Review the ` +
				`position before its 3-day init period elapses.\n\n` +
				`[Citreascan](https://citreascan.com/address/${c.address})`;

			const delivered = await telegramService.sendCriticalAlert(message);
			if (delivered) {
				await this.positionRepo.markSuspiciousLiqPriceAlerted(c.address, now);
				this.logger.warn(`Suspicious-liq-price alert sent for ${c.address} (${reasons.length} trigger(s))`);
			}
			await sleep(TELEGRAM_THROTTLE_MS);
		}
	}
}

/** Format an 18-decimal JUSD principal string with two decimal places and locale separators. */
function formatJusd(principalRaw: string): string {
	const cents = BigInt(principalRaw) / 10n ** 16n;
	return (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
