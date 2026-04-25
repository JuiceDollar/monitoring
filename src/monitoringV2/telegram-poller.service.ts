import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from 'src/config/config.service';
import { TelegramSubscriberRepository } from './prisma/repositories/telegram-subscriber.repository';
import { TelegramPollStateRepository } from './prisma/repositories/telegram-poll-state.repository';

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

interface GetUpdatesResponse {
	ok: boolean;
	result: TelegramUpdate[];
	description?: string;
}

@Injectable()
export class TelegramPollerService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(TelegramPollerService.name);
	private readonly botToken: string;
	private readonly enabled: boolean;
	private readonly longPollTimeoutSec = 30;
	private readonly errorBackoffMs = 5000;

	private isStopped = false;
	private currentAbort?: AbortController;

	constructor(
		private readonly config: AppConfigService,
		private readonly subscriberRepo: TelegramSubscriberRepository,
		private readonly pollStateRepo: TelegramPollStateRepository
	) {
		this.botToken = this.config.telegramBotToken;
		this.enabled = this.config.telegramAlertsEnabled && !!this.botToken;
	}

	async onModuleInit() {
		if (!this.enabled) {
			this.logger.log('Telegram poller disabled (no token or alerts disabled)');
			return;
		}

		await this.subscriberRepo.ensureBootstrap(this.config.telegramBootstrapSubscribers);

		this.logger.log('Telegram poller starting');
		// Run loop without awaiting so module init doesn't block
		void this.pollLoop();
	}

	async onModuleDestroy() {
		this.isStopped = true;
		this.currentAbort?.abort();
		this.logger.log('Telegram poller stopped');
	}

	private async pollLoop(): Promise<void> {
		while (!this.isStopped) {
			try {
				const offset = (await this.pollStateRepo.getLastUpdateId()) + 1;
				const updates = await this.getUpdates(offset);
				for (const update of updates) {
					try {
						await this.handleUpdate(update);
					} catch (error) {
						this.logger.error(`Failed to handle update ${update.update_id}: ${error.message}`);
					}
					await this.pollStateRepo.setLastUpdateId(update.update_id);
				}
			} catch (error) {
				if (this.isStopped) return;
				if (error.name === 'AbortError') return;
				this.logger.error(`Polling error: ${error.message}`);
				await this.sleep(this.errorBackoffMs);
			}
		}
	}

	private async getUpdates(offset: number): Promise<TelegramUpdate[]> {
		const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
		this.currentAbort = new AbortController();

		// Telegram allows the request to hang up to `timeout` seconds; add a small client-side margin.
		const clientTimeout = setTimeout(() => this.currentAbort?.abort(), (this.longPollTimeoutSec + 5) * 1000);

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					offset,
					timeout: this.longPollTimeoutSec,
					allowed_updates: ['message'],
				}),
				signal: this.currentAbort.signal,
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Telegram getUpdates HTTP ${response.status}: ${body}`);
			}

			const data = (await response.json()) as GetUpdatesResponse;
			if (!data.ok) throw new Error(`Telegram getUpdates not ok: ${data.description}`);
			return data.result;
		} finally {
			clearTimeout(clientTimeout);
			this.currentAbort = undefined;
		}
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		const message = update.message;
		if (!message?.text || !message.from) return;

		const text = message.text.trim();
		const chatId = String(message.chat.id);
		const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();

		switch (command) {
			case '/start':
				await this.handleStart(chatId, message);
				break;
			case '/stop':
				await this.handleStop(chatId);
				break;
			case '/status':
				await this.handleStatus(chatId);
				break;
			default:
				// Silent ignore for non-command messages
				break;
		}
	}

	private async handleStart(chatId: string, message: TelegramMessage): Promise<void> {
		await this.subscriberRepo.upsertActive({
			chatId,
			username: message.from?.username,
			firstName: message.from?.first_name,
			lastName: message.from?.last_name,
		});
		await this.sendReply(
			chatId,
			'✅ Du erhältst ab jetzt JuiceDollar Monitoring Alerts.\n\nKommandos:\n/stop — abbestellen\n/status — Abo-Status'
		);
	}

	private async handleStop(chatId: string): Promise<void> {
		await this.subscriberRepo.deactivate(chatId);
		await this.sendReply(chatId, '❌ Du erhältst keine Alerts mehr. /start um wieder zu abonnieren.');
	}

	private async handleStatus(chatId: string): Promise<void> {
		const active = await this.subscriberRepo.isActive(chatId);
		await this.sendReply(chatId, active ? '✅ Du bist abonniert.' : '❌ Du bist nicht abonniert. /start zum abonnieren.');
	}

	private async sendReply(chatId: string, text: string): Promise<void> {
		const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
			});
			if (!response.ok) {
				const body = await response.text();
				this.logger.warn(`Failed to send reply to ${chatId}: HTTP ${response.status}: ${body}`);
			}
		} catch (error) {
			this.logger.warn(`Failed to send reply to ${chatId}: ${error.message}`);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
