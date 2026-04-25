import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';

export interface SubscriberInfo {
	chatId: string;
	username?: string | null;
	firstName?: string | null;
	lastName?: string | null;
}

@Injectable()
export class TelegramSubscriberRepository {
	private readonly logger = new Logger(TelegramSubscriberRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async upsertActive(info: SubscriberInfo): Promise<void> {
		try {
			await this.prisma.telegramSubscriber.upsert({
				where: { chatId: info.chatId },
				create: {
					chatId: info.chatId,
					username: info.username ?? null,
					firstName: info.firstName ?? null,
					lastName: info.lastName ?? null,
					active: true,
				},
				update: {
					username: info.username ?? null,
					firstName: info.firstName ?? null,
					lastName: info.lastName ?? null,
					active: true,
				},
			});
			this.logger.debug(`Upserted active subscriber: ${info.chatId}`);
		} catch (error) {
			this.logger.error(`Failed to upsert subscriber ${info.chatId}: ${error.message}`);
			throw error;
		}
	}

	async deactivate(chatId: string): Promise<void> {
		try {
			await this.prisma.telegramSubscriber.update({
				where: { chatId },
				data: { active: false },
			});
			this.logger.debug(`Deactivated subscriber: ${chatId}`);
		} catch (error) {
			if (error.code === 'P2025') {
				// Record not found — already gone
				return;
			}
			this.logger.error(`Failed to deactivate subscriber ${chatId}: ${error.message}`);
			throw error;
		}
	}

	async isActive(chatId: string): Promise<boolean> {
		const subscriber = await this.prisma.telegramSubscriber.findUnique({
			where: { chatId },
			select: { active: true },
		});
		return subscriber?.active ?? false;
	}

	async listActiveChatIds(): Promise<string[]> {
		const subscribers = await this.prisma.telegramSubscriber.findMany({
			where: { active: true },
			select: { chatId: true },
		});
		return subscribers.map((s) => s.chatId);
	}

	async ensureBootstrap(chatIds: string[]): Promise<void> {
		if (chatIds.length === 0) return;
		for (const chatId of chatIds) {
			await this.upsertActive({ chatId });
		}
		this.logger.log(`Bootstrap subscribers ensured: ${chatIds.join(', ')}`);
	}
}
