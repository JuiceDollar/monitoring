import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { Event, PositionOpenedEvent, ChallengeStartedEvent } from '../../types';

@Injectable()
export class EventsRepository {
	private readonly logger = new Logger(EventsRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async createMany(events: Event[]): Promise<void> {
		if (events.length === 0) return;

		try {
			await this.prisma.rawEvent.createMany({
				data: events.map((e) => ({
					...e,
					contractAddress: e.contractAddress.toLowerCase(),
				})),
				skipDuplicates: true,
			});

			this.logger.log(`Successfully persisted ${events.length} raw events`);
		} catch (error) {
			this.logger.error(`Failed to persist raw events: ${error.message}`);
			throw error;
		}
	}

	async getUnalertedEvents(hoursAgo: number = 12): Promise<Event[]> {
		const cutoffTime = BigInt(Math.floor(Date.now() / 1000) - hoursAgo * 3600);
		const rawEvents = await this.prisma.rawEvent.findMany({
			where: {
				alerted: false,
				timestamp: { gte: cutoffTime },
			},
			orderBy: { timestamp: 'asc' },
		});

		return rawEvents.map((e) => ({ ...e, args: e.args as Record<string, any> }));
	}

	async markAsAlerted(txHash: string, logIndex: number): Promise<void> {
		try {
			await this.prisma.rawEvent.update({
				where: { txHash_logIndex: { txHash, logIndex } },
				data: { alerted: true },
			});
		} catch (error) {
			this.logger.error(`Failed to mark event ${txHash} at logIndex ${logIndex} as alerted: ${error.message}`);
			// no throw, non-critical
		}
	}

	async getCollateralTokens(): Promise<string[]> {
		try {
			const events = await this.prisma.rawEvent.findMany({
				where: { topic: 'PositionOpened' },
				select: { args: true },
			});

			const collateralAddresses = events.map((e) => (e.args as any)?.collateral?.toLowerCase()).filter(Boolean);
			return Array.from(new Set(collateralAddresses));
		} catch (error) {
			this.logger.error(`Failed to get collateral tokens: ${error.message}`);
			throw error;
		}
	}

	async getPositions(): Promise<PositionOpenedEvent[]> {
		try {
			const events = await this.prisma.rawEvent.findMany({
				where: { topic: 'PositionOpened' },
				select: { args: true, timestamp: true },
				orderBy: { timestamp: 'asc' },
			});

			return events.map((e) => {
				const data = e.args as any;
				return {
					address: data.position?.toLowerCase(),
					owner: data.owner?.toLowerCase(),
					original: data.original?.toLowerCase(),
					collateral: data.collateral?.toLowerCase(),
					timestamp: e.timestamp,
				};
			});
		} catch (error) {
			this.logger.error(`Failed to get positions from PositionOpened events: ${error.message}`);
			throw error;
		}
	}

	async getDeniedPositions(): Promise<string[]> {
		try {
			const events = await this.prisma.rawEvent.findMany({
				where: { topic: 'PositionDenied' },
				select: { contractAddress: true },
			});

			const deniedAddresses = events.map((e) => e.contractAddress.toLowerCase());
			return Array.from(new Set(deniedAddresses));
		} catch (error) {
			this.logger.error(`Failed to get denied positions from PositionDenied events: ${error.message}`);
			throw error;
		}
	}

	async getDeniedMinters(): Promise<string[]> {
		try {
			const events = await this.prisma.rawEvent.findMany({
				where: { topic: 'MinterDenied' },
				select: { args: true },
			});

			const deniedAddresses = events.map((e) => (e.args as any)?.minter?.toLowerCase()).filter(Boolean);
			return Array.from(new Set(deniedAddresses));
		} catch (error) {
			this.logger.error(`Failed to get denied minters from MinterDenied events: ${error.message}`);
			throw error;
		}
	}

	async getChallengeStartedEvents(): Promise<ChallengeStartedEvent[]> {
		try {
			const events = await this.prisma.rawEvent.findMany({
				where: { topic: 'ChallengeStarted' },
				select: { args: true, blockNumber: true, timestamp: true, contractAddress: true },
				orderBy: { timestamp: 'asc' },
			});

			return events
				.map((event) => {
					const data = event.args as any;
					return {
						challengeId: data.number ? Number(data.number) : undefined,
						challenger: data.challenger?.toLowerCase(),
						position: data.position?.toLowerCase(),
						size: data.size ? BigInt(data.size) : undefined,
						timestamp: event.timestamp,
						hubAddress: event.contractAddress.toLowerCase(),
					};
				})
				.filter((c) => c.challengeId !== undefined);
		} catch (error) {
			this.logger.error(`Failed to get challenge started events: ${error.message}`);
			throw error;
		}
	}

	async aggregateEventData(topic: string, arg: string, since?: number): Promise<bigint> {
		const events = await this.prisma.rawEvent.findMany({
			where: {
				topic,
				...(since && { timestamp: { gte: BigInt(since) } }),
			},
			select: { args: true },
		});

		return events.reduce((sum, e) => {
			const args = e.args as any;
			const amount = args?.[arg] || 0;
			return sum + BigInt(amount);
		}, BigInt(0));
	}

	async getEventCount(topic: string, since?: number): Promise<number> {
		return this.prisma.rawEvent.count({
			where: {
				topic,
				...(since && { timestamp: { gte: BigInt(since) } }),
			},
		});
	}

	async calculateEquityTradeFees(since?: number): Promise<bigint> {
		const tradeEvents = await this.prisma.rawEvent.findMany({
			where: {
				topic: 'Trade',
				...(since && { timestamp: { gte: BigInt(since) } }),
			},
			select: { args: true },
		});

		return tradeEvents.reduce((totalFees, event) => {
			const args = event.args as any;
			const totPrice = BigInt(args?.totPrice || 0);
			const amount = BigInt(args?.amount || 0);
			const tradingFee = amount > 0n ? (totPrice * 2n) / 100n : totPrice / 49n;
			return totalFees + tradingFee;
		}, 0n);
	}
}
