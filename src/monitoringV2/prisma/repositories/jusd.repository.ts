import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { JusdState } from '../../types';

@Injectable()
export class JusdRepository {
	private readonly logger = new Logger(JusdRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async getState(): Promise<JusdState | null> {
		const state = await this.prisma.jusdState.findUnique({
			where: { id: 1 },
		});

		if (!state) return null;

		return {
			jusdTotalSupply: BigInt(state.jusdTotalSupply.toFixed(0)),
			juiceTotalSupply: BigInt(state.juiceTotalSupply.toFixed(0)),
			equityShares: BigInt(state.equityShares.toFixed(0)),
			equityPrice: BigInt(state.equityPrice.toFixed(0)),
			reserveTotal: BigInt(state.reserveTotal.toFixed(0)),
			reserveMinter: BigInt(state.reserveMinter.toFixed(0)),
			reserveEquity: BigInt(state.reserveEquity.toFixed(0)),
			savingsTotal: BigInt(state.savingsTotal.toFixed(0)),
			savingsInterestCollected: BigInt(state.savingsInterestCollected.toFixed(0)),
			savingsRate: state.savingsRate,
			jusdLoss: BigInt(state.jusdLoss.toFixed(0)),
			jusdProfit: BigInt(state.jusdProfit.toFixed(0)),
			jusdProfitDistributed: BigInt(state.jusdProfitDistributed.toFixed(0)),
			frontendFeesCollected: BigInt(state.frontendFeesCollected.toFixed(0)),
			frontendsActive: state.frontendsActive,
			savingsInterestCollected24h: BigInt(state.savingsInterestCollected24h.toFixed(0)),
			savingsAdded24h: BigInt(state.savingsAdded24h.toFixed(0)),
			savingsWithdrawn24h: BigInt(state.savingsWithdrawn24h.toFixed(0)),
			equityTradeVolume24h: BigInt(state.equityTradeVolume24h.toFixed(0)),
			equityTradeCount24h: state.equityTradeCount24h,
			equityDelegations24h: state.equityDelegations24h,
			blockNumber: state.blockNumber,
			timestamp: state.timestamp,
		};
	}

	async upsertState(state: JusdState): Promise<void> {
		try {
			await this.prisma.jusdState.upsert({
				where: { id: 1 },
				create: {
					id: 1,
					jusdTotalSupply: state.jusdTotalSupply.toString(),
					juiceTotalSupply: state.juiceTotalSupply.toString(),
					equityShares: state.equityShares.toString(),
					equityPrice: state.equityPrice.toString(),
					reserveTotal: state.reserveTotal.toString(),
					reserveMinter: state.reserveMinter.toString(),
					reserveEquity: state.reserveEquity.toString(),
					savingsTotal: state.savingsTotal.toString(),
					savingsInterestCollected: state.savingsInterestCollected.toString(),
					savingsRate: state.savingsRate,
					jusdLoss: state.jusdLoss.toString(),
					jusdProfit: state.jusdProfit.toString(),
					jusdProfitDistributed: state.jusdProfitDistributed.toString(),
					frontendFeesCollected: state.frontendFeesCollected.toString(),
					frontendsActive: state.frontendsActive,
					savingsInterestCollected24h: state.savingsInterestCollected24h.toString(),
					savingsAdded24h: state.savingsAdded24h.toString(),
					savingsWithdrawn24h: state.savingsWithdrawn24h.toString(),
					equityTradeVolume24h: state.equityTradeVolume24h.toString(),
					equityTradeCount24h: state.equityTradeCount24h,
					equityDelegations24h: state.equityDelegations24h,
					blockNumber: state.blockNumber,
					timestamp: state.timestamp,
				},
				update: {
					jusdTotalSupply: state.jusdTotalSupply.toString(),
					juiceTotalSupply: state.juiceTotalSupply.toString(),
					equityShares: state.equityShares.toString(),
					equityPrice: state.equityPrice.toString(),
					reserveTotal: state.reserveTotal.toString(),
					reserveMinter: state.reserveMinter.toString(),
					reserveEquity: state.reserveEquity.toString(),
					savingsTotal: state.savingsTotal.toString(),
					savingsInterestCollected: state.savingsInterestCollected.toString(),
					savingsRate: state.savingsRate,
					jusdLoss: state.jusdLoss.toString(),
					jusdProfit: state.jusdProfit.toString(),
					jusdProfitDistributed: state.jusdProfitDistributed.toString(),
					frontendFeesCollected: state.frontendFeesCollected.toString(),
					frontendsActive: state.frontendsActive,
					savingsInterestCollected24h: state.savingsInterestCollected24h.toString(),
					savingsAdded24h: state.savingsAdded24h.toString(),
					savingsWithdrawn24h: state.savingsWithdrawn24h.toString(),
					equityTradeVolume24h: state.equityTradeVolume24h.toString(),
					equityTradeCount24h: state.equityTradeCount24h,
					equityDelegations24h: state.equityDelegations24h,
					blockNumber: state.blockNumber,
					timestamp: state.timestamp,
				},
			});

			this.logger.debug('Successfully upserted JUSD state');
		} catch (error) {
			this.logger.error(`Failed to upsert JUSD state: ${error.message}`);
			throw error;
		}
	}
}
