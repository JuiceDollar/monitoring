import { Injectable, Logger } from '@nestjs/common';
import { ChallengeState, ChallengeStartedEvent } from './types';
import { AppConfigService } from '../config/config.service';
import { MintingHubV2ABI, ADDRESS } from '@juicedollar/jusd';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { ChallengeRepository } from './prisma/repositories/challenge.repository';
import { EventsRepository } from './prisma/repositories/events.repository';

@Injectable()
export class ChallengeService {
	private readonly logger = new Logger(ChallengeService.name);
	private existingChallenges = new Set<string>(); // composite key: "challengeId:hubAddress"

	constructor(
		private readonly config: AppConfigService,
		private readonly challengeRepo: ChallengeRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly providerService: ProviderService
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
}
