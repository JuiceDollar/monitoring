import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';

@Injectable()
export class SyncStateRepository {
	private readonly logger = new Logger(SyncStateRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async getLastProcessedBlock(): Promise<number | null> {
		const syncState = await this.prisma.syncState.findUnique({
			where: { id: 1 },
			select: { lastProcessedBlock: true },
		});

		const blockNumber = syncState ? Number(syncState.lastProcessedBlock) : null;
		this.logger.debug(`Retrieved last processed block: ${blockNumber}`);
		return blockNumber;
	}

	async updateLastProcessedBlock(blockNumber: number): Promise<void> {
		try {
			await this.prisma.syncState.upsert({
				where: { id: 1 },
				create: {
					id: 1,
					lastProcessedBlock: blockNumber,
					timestamp: new Date(),
				},
				update: {
					lastProcessedBlock: blockNumber,
					timestamp: new Date(),
				},
			});

			this.logger.debug(`Updated last processed block to: ${blockNumber}`);
		} catch (error) {
			this.logger.error(`Failed to update last processed block: ${error.message}`);
			throw error;
		}
	}

	async getLastCompletedBlock(): Promise<number | null> {
		const syncState = await this.prisma.syncState.findUnique({
			where: { id: 1 },
			select: { lastCompletedBlock: true },
		});

		const blockNumber = syncState?.lastCompletedBlock ? Number(syncState.lastCompletedBlock) : null;
		this.logger.debug(`Retrieved last completed block: ${blockNumber}`);
		return blockNumber;
	}

	async updateLastCompletedBlock(blockNumber: number): Promise<void> {
		try {
			await this.prisma.syncState.upsert({
				where: { id: 1 },
				create: {
					id: 1,
					lastCompletedBlock: blockNumber,
					timestamp: new Date(),
				},
				update: {
					lastCompletedBlock: blockNumber,
					timestamp: new Date(),
				},
			});

			this.logger.debug(`Updated last completed block to: ${blockNumber}`);
		} catch (error) {
			this.logger.error(`Failed to update last completed block: ${error.message}`);
			throw error;
		}
	}
}
