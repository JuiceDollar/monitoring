import { Injectable, Logger } from '@nestjs/common';
import { JusdState } from './types';
import { JusdRepository } from './prisma/repositories/jusd.repository';
import { ProviderService } from './provider.service';
import { AppConfigService } from '../config/config.service';
import { ethers } from 'ethers';
import { JuiceDollarABI, EquityABI, SavingsGatewayABI, ADDRESS } from '@juicedollar/jusd';
import { EventsRepository } from './prisma/repositories/events.repository';
import { PositionRepository } from './prisma/repositories/position.repository';

@Injectable()
export class JusdService {
	private readonly logger = new Logger(JusdService.name);

	constructor(
		private readonly config: AppConfigService,
		private readonly jusdRepo: JusdRepository,
		private readonly providerService: ProviderService,
		private readonly eventsRepo: EventsRepository,
		private readonly positionRepo: PositionRepository,
	) {}

	async initialize(): Promise<void> {
		this.logger.log('JusdService initialized');
	}

	async syncState(): Promise<void> {
		const chainId = this.config.blockchainId;
		const multicallProvider = this.providerService.multicallProvider;
		const jusd = new ethers.Contract(ADDRESS[chainId].juiceDollar, JuiceDollarABI, multicallProvider);
		const equity = new ethers.Contract(ADDRESS[chainId].equity, EquityABI, multicallProvider);
		const savings = new ethers.Contract(ADDRESS[chainId].savingsGateway, SavingsGatewayABI, multicallProvider);

		// Contract calls
		const calls: Array<() => Promise<any>> = [];
		calls.push(() => jusd.totalSupply());
		calls.push(() => equity.totalSupply());
		calls.push(() => equity.totalSupply()); // JUICE total supply = equity total supply
		calls.push(() => equity.price());
		calls.push(() => jusd.balanceOf(ADDRESS[chainId].equity));
		calls.push(() => jusd.minterReserve());
		calls.push(() => jusd.equity());
		calls.push(() => jusd.balanceOf(ADDRESS[chainId].savingsGateway));
		calls.push(() => savings.currentRatePPM());
		const results = await this.providerService.callBatch(calls);

		let idx = 0;
		const jusdTotalSupply = BigInt(results[idx++]);
		const juiceTotalSupply = BigInt(results[idx++]);
		const equityShares = BigInt(results[idx++]);
		const equityPrice = BigInt(results[idx++]);
		const reserveTotal = BigInt(results[idx++]);
		const reserveMinter = BigInt(results[idx++]);
		const reserveEquity = BigInt(results[idx++]);
		const savingsTotal = BigInt(results[idx++]);
		const savingsRate = Number(results[idx++]);

		// Event aggregations and other data
		const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

		const [
			savingsInterestCollected,
			jusdLoss,
			jusdProfit,
			equityTradeFees,
			positionInterest,
			jusdProfitDistributed,
			frontendFeesCollected,
			frontendsActive,
			savingsInterestCollected24h,
			savingsAdded24h,
			savingsWithdrawn24h,
			equityTradeVolume24h,
			equityTradeCount24h,
			equityDelegations24h,
			blockNumber,
		] = await Promise.all([
			this.eventsRepo.aggregateEventData('InterestCollected', 'interest'),
			this.eventsRepo.aggregateEventData('Loss', 'amount'),
			this.eventsRepo.aggregateEventData('Profit', 'amount'),
			this.eventsRepo.calculateEquityTradeFees(),
			this.positionRepo.getTotalPositionInterest(),
			this.eventsRepo.aggregateEventData('ProfitDistributed', 'amount'),
			this.eventsRepo.aggregateEventData('FrontendCodeRewardsWithdrawn', 'amount'),
			this.eventsRepo.getEventCount('FrontendCodeRegistered'),
			this.eventsRepo.aggregateEventData('InterestCollected', 'interest', oneDayAgo),
			this.eventsRepo.aggregateEventData('Saved', 'amount', oneDayAgo),
			this.eventsRepo.aggregateEventData('Withdrawn', 'amount', oneDayAgo),
			this.eventsRepo.aggregateEventData('Trade', 'totPrice', oneDayAgo),
			this.eventsRepo.getEventCount('Trade', oneDayAgo),
			this.eventsRepo.getEventCount('Delegation', oneDayAgo),
			this.providerService.getBlockNumber(),
		]);

		// Build state
		const state: JusdState = {
			jusdTotalSupply,
			juiceTotalSupply,
			equityShares,
			equityPrice,
			reserveTotal,
			reserveMinter,
			reserveEquity,
			savingsTotal,
			savingsInterestCollected,
			savingsRate,
			jusdLoss,
			jusdProfit: jusdProfit + equityTradeFees + positionInterest,
			jusdProfitDistributed,
			frontendFeesCollected,
			frontendsActive,
			savingsInterestCollected24h,
			savingsAdded24h,
			savingsWithdrawn24h,
			equityTradeVolume24h,
			equityTradeCount24h,
			equityDelegations24h,
			blockNumber: BigInt(blockNumber),
			timestamp: new Date(),
		};

		// Persist to database
		await this.jusdRepo.upsertState(state);
		this.logger.log('Successfully synced JUSD state');
	}
}
