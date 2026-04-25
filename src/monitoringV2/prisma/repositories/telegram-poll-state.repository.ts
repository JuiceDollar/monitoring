import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';

@Injectable()
export class TelegramPollStateRepository {
	private readonly logger = new Logger(TelegramPollStateRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async getLastUpdateId(): Promise<number> {
		const state = await this.prisma.telegramPollState.findUnique({
			where: { id: 1 },
			select: { lastUpdateId: true },
		});
		return state ? Number(state.lastUpdateId) : 0;
	}

	async setLastUpdateId(updateId: number): Promise<void> {
		try {
			await this.prisma.telegramPollState.upsert({
				where: { id: 1 },
				create: { id: 1, lastUpdateId: updateId },
				update: { lastUpdateId: updateId },
			});
			this.logger.debug(`Updated last Telegram update_id to: ${updateId}`);
		} catch (error) {
			this.logger.error(`Failed to update last update_id: ${error.message}`);
			throw error;
		}
	}
}
