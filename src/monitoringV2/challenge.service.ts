import { Injectable, Logger } from '@nestjs/common';
import { ChallengeState, ChallengeStartedEvent } from './types';
import { AppConfigService } from '../config/config.service';
import { MintingHubV2ABI, ADDRESS } from '@juicedollar/jusd';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { ChallengeRepository } from './prisma/repositories/challenge.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TelegramService } from './telegram.service';

@Injectable()
export class ChallengeService {
	private readonly logger = new Logger(ChallengeService.name);
	private existingChallenges = new Set<string>(); // composite key: "challengeId:hubAddress"

	private static readonly T24_SECONDS = 24n * 3600n;
	private static readonly T2_SECONDS = 2n * 3600n;

	constructor(
		private readonly config: AppConfigService,
		private readonly challengeRepo: ChallengeRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly providerService: ProviderService,
		private readonly telegramService: TelegramService
	) {}

	private static challengeKey(challengeId: number, hubAddress: string): string {
		return `${challengeId}:${hubAddress.toLowerCase()}`;
	}

	async initialize(): Promise<void> {
		const keys = await this.challengeRepo.findAllChallengeKeys();
		this.existingChallenges = new Set(keys.map((k) => ChallengeService.challengeKey(k.challengeId, k.hubAddress)));
		this.logger.log(`Loaded ${this.existingChallenges.size} existing challenges`);
	}

	async syncChallenges(): Promise<void> {
		const challengeStartedEvents = await this.eventsRepo.getChallengeStartedEvents();
		if (challengeStartedEvents.length === 0) return;

		// Fetch on-chain data
		const challengeStates = await this.fetchChallengeData(challengeStartedEvents);

		// Persist
		const newStates = challengeStates.filter((c) => c.challengerAddress !== undefined);
		const existingStates = challengeStates.filter((c) => c.challengerAddress === undefined);
		if (newStates.length > 0) await this.challengeRepo.createMany(newStates);
		if (existingStates.length > 0) await this.challengeRepo.updateMany(existingStates);

		// Update cache
		for (const challenge of challengeStates) {
			this.existingChallenges.add(ChallengeService.challengeKey(challenge.challengeId!, challenge.hubAddress!));
		}
		this.logger.log(`Successfully synced ${challengeStates.length} challenge states`);
	}

	private async fetchChallengeData(challengeStartedEvents: ChallengeStartedEvent[]): Promise<Partial<ChallengeState>[]> {
		const multicallProvider = this.providerService.multicallProvider;
		const timestamp = new Date();

		// Create hub contract instances (one per unique hub address)
		const hubContracts = new Map<string, ethers.Contract>();
		for (const event of challengeStartedEvents) {
			const hub = event.hubAddress.toLowerCase();
			if (!hubContracts.has(hub)) {
				hubContracts.set(hub, new ethers.Contract(hub, MintingHubV2ABI, multicallProvider));
			}
		}

		// Fetch on-chain data — query each challenge on its correct hub
		const calls: Array<() => Promise<any>> = [];
		for (const event of challengeStartedEvents) {
			const hub = hubContracts.get(event.hubAddress.toLowerCase())!;
			calls.push(() => hub.challenges(event.challengeId));
			calls.push(() => hub.price(event.challengeId));
		}

		// Execute multicall
		const responses = await this.providerService.callBatch(calls);

		let responseIndex = 0;
		const challenges: Partial<ChallengeState>[] = [];
		for (const event of challengeStartedEvents) {
			const key = ChallengeService.challengeKey(event.challengeId, event.hubAddress);
			const isNew = !this.existingChallenges.has(key);
			const challengeData = responses[responseIndex++];
			const currentPrice = BigInt(responses[responseIndex++]);
			const state: Partial<ChallengeState> = {
				challengeId: event.challengeId,
				hubAddress: event.hubAddress.toLowerCase(),
				size: BigInt(challengeData.size),
				currentPrice,
				timestamp,
			};

			if (isNew) {
				state.challengerAddress = event.challenger;
				state.positionAddress = event.position;
				state.startTimestamp = event.timestamp;
				state.initialSize = event.size;
			}

			challenges.push(state);
		}

		return challenges;
	}

	/**
	 * Emits Telegram critical alerts for active challenges approaching auction end.
	 * Two stages: T-24h (first warning) and T-2h (last call). Each stage fires at most once
	 * per challenge thanks to the t24Alerted / t2Alerted persistence flags.
	 *
	 * Auction end is start + 2 * challengePeriod (Frankencoin pattern: phase 1 + phase 2).
	 */
	async checkAuctionDeadlines(): Promise<void> {
		const challenges = await this.challengeRepo.findActiveWithChallengePeriod();
		if (challenges.length === 0) return;

		const now = BigInt(Math.floor(Date.now() / 1000));

		for (const c of challenges) {
			try {
				const auctionEnd = c.startTimestamp + 2n * c.challengePeriod;
				const remaining = auctionEnd - now;
				if (remaining <= 0n) continue;

				if (remaining <= ChallengeService.T2_SECONDS && !c.t2Alerted) {
					await this.sendDeadlineAlert(c, '2h', remaining, auctionEnd);
					await this.challengeRepo.markT2Alerted(c.challengeId, c.hubAddress);
					if (!c.t24Alerted) {
						await this.challengeRepo.markT24Alerted(c.challengeId, c.hubAddress);
					}
					continue;
				}
				if (remaining <= ChallengeService.T24_SECONDS && !c.t24Alerted) {
					await this.sendDeadlineAlert(c, '24h', remaining, auctionEnd);
					await this.challengeRepo.markT24Alerted(c.challengeId, c.hubAddress);
				}
			} catch (error) {
				const msg = (error as { message?: string })?.message ?? String(error);
				this.logger.warn(`Watchdog skipped challenge #${c.challengeId} on ${c.hubAddress}: ${msg}`);
			}
		}
	}

	private async sendDeadlineAlert(
		c: {
			challengeId: number;
			hubAddress: string;
			positionAddress: string;
			challengerAddress: string;
			size: bigint;
			currentPrice: bigint;
		},
		stage: '24h' | '2h',
		remainingSeconds: bigint,
		auctionEnd: bigint
	): Promise<void> {
		const remHours = (Number(remainingSeconds) / 3600).toFixed(1);
		const endIso = new Date(Number(auctionEnd) * 1000).toISOString();
		const header = stage === '2h' ? 'T-2h: Auction ends in 2h' : 'T-24h: Auction ends in 24h';
		const lines = [
			header,
			'',
			`Challenge #${c.challengeId}`,
			`Position: ${c.positionAddress}`,
			`Challenger: ${c.challengerAddress}`,
			`Hub: ${c.hubAddress}`,
			`Size remaining: ${c.size.toString()}`,
			`Current bid price: ${c.currentPrice.toString()}`,
			`Auction end: ${endIso} (${remHours}h remaining)`,
		];
		await this.telegramService.sendCriticalAlert(lines.join('\n'));
		this.logger.log(`Sent ${stage} deadline alert for challenge #${c.challengeId} on ${c.hubAddress}`);
	}
}
