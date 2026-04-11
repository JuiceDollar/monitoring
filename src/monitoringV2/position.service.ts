import { Injectable, Logger } from '@nestjs/common';
import { PositionOpenedEvent, PositionState } from './types';
import { AppConfigService } from '../config/config.service';
import { PositionV2ABI, MintingHubV2ABI, ADDRESS, ERC20ABI } from '@juicedollar/jusd';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { PositionRepository } from './prisma/repositories/position.repository';
import { EventsRepository } from './prisma/repositories/events.repository';

@Injectable()
export class PositionService {
	private readonly logger = new Logger(PositionService.name);
	private existingPositions = new Set<string>(); // Just track addresses

	constructor(
		private readonly config: AppConfigService,
		private readonly positionRepo: PositionRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly providerService: ProviderService
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
}
