import { Injectable, Logger } from '@nestjs/common';
import { Event } from './types';
import { EVENT_CONFIG, EventSeverity } from './events.config';
import { PositionRepository } from './prisma/repositories/position.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { TelegramSubscriberRepository } from './prisma/repositories/telegram-subscriber.repository';
import { AppConfigService } from 'src/config/config.service';

interface TelegramApiError {
	ok: false;
	error_code: number;
	description: string;
}

@Injectable()
export class TelegramService {
	private readonly logger = new Logger(TelegramService.name);
	private readonly botToken: string;
	private readonly enabled: boolean;
	private readonly explorerBaseUrl: string;
	private readonly perMessageDelayMs = 50; // ~20 msgs/sec, well under Telegram's 30/sec global limit

	constructor(
		private readonly config: AppConfigService,
		private readonly positionRepo: PositionRepository,
		private readonly eventsRepo: EventsRepository,
		private readonly subscriberRepo: TelegramSubscriberRepository
	) {
		this.botToken = this.config.telegramBotToken;
		this.enabled = this.config.telegramAlertsEnabled && !!this.botToken;
		this.explorerBaseUrl = this.config.explorerBaseUrl.replace(/\/$/, '');
		this.logger.log(`Telegram notifications are ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
	}

	async sendPendingAlerts(): Promise<void> {
		if (!this.enabled) return;

		try {
			const unalertedEvents = await this.eventsRepo.getUnalertedEvents(this.config.alertTimeframeHours);
			if (unalertedEvents.length === 0) return;

			this.logger.log(`Sending alerts for ${unalertedEvents.length} events`);
			for (const event of unalertedEvents) {
				const success = await this.notifyEvent(event);
				if (success) await this.eventsRepo.markAsAlerted(event.txHash, event.logIndex);
			}
		} catch (error) {
			this.logger.error(`Error in event alert phase: ${error.message}`, error.stack);
		}
	}

	async sendCriticalAlert(message: string): Promise<void> {
		if (!this.enabled) return;

		try {
			const formattedMessage = `🚨 *CRITICAL ALERT*\n\n${message}\n\n_Timestamp: ${new Date().toISOString()}_`;
			await this.broadcast(formattedMessage);
			this.logger.log('Critical alert broadcast');
		} catch (error) {
			this.logger.error(`Failed to broadcast critical alert: ${error.message}`);
		}
	}

	private async notifyEvent(event: Event): Promise<boolean> {
		const config = EVENT_CONFIG[event.topic];
		if (!config || config.enabled === false) return true;

		const severity = await this.getDynamicSeverity(event, config.severity);
		if (severity === EventSeverity.LOW) return true; // suppress to avoid rehandling next cycle

		try {
			const time = this.formatTimestamp(event.timestamp);
			const message = this.constructMessage(event, severity, time);
			await this.broadcast(message);
		} catch (error) {
			this.logger.error(`Failed to broadcast event ${event.topic}: ${error.message}`);
			return false;
		}

		return true;
	}

	private async broadcast(text: string): Promise<void> {
		const chatIds = await this.subscriberRepo.listActiveChatIds();
		if (chatIds.length === 0) {
			this.logger.warn('Broadcast skipped: no active subscribers');
			return;
		}

		for (const chatId of chatIds) {
			await this.sendMessage(chatId, text);
			await this.sleep(this.perMessageDelayMs);
		}
	}

	private async sendMessage(chatId: string, text: string): Promise<void> {
		const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text,
					parse_mode: 'Markdown',
					disable_web_page_preview: true,
				}),
				signal: controller.signal,
			});

			if (response.ok) return;

			let apiError: TelegramApiError | undefined;
			try {
				apiError = (await response.json()) as TelegramApiError;
			} catch {
				// non-JSON body — fall through to logging below
			}

			if (this.shouldDeactivate(response.status, apiError)) {
				await this.subscriberRepo.deactivate(chatId);
				this.logger.log(`Deactivated subscriber ${chatId}: ${apiError?.description ?? response.statusText}`);
				return;
			}

			this.logger.warn(
				`Telegram sendMessage to ${chatId} failed: HTTP ${response.status} ${apiError?.description ?? response.statusText}`
			);
		} catch (error) {
			this.logger.warn(`Telegram sendMessage to ${chatId} threw: ${error.message}`);
		} finally {
			clearTimeout(timeout);
		}
	}

	private shouldDeactivate(httpStatus: number, apiError: TelegramApiError | undefined): boolean {
		// 403: bot was blocked / kicked / chat deleted
		// 400 with "chat not found" or "user is deactivated"
		if (httpStatus === 403) return true;
		if (httpStatus === 400 && apiError) {
			const desc = apiError.description.toLowerCase();
			return desc.includes('chat not found') || desc.includes('user is deactivated') || desc.includes('group chat was upgraded');
		}
		return false;
	}

	private async getDynamicSeverity(event: Event, severity: EventSeverity): Promise<EventSeverity> {
		if (event.topic === 'PositionOpened') {
			const isNewPosition = event.args.position === event.args.original;
			return isNewPosition ? EventSeverity.HIGH : EventSeverity.LOW;
		} else if (event.topic === 'MintingUpdate') {
			try {
				const inCooldown = await this.positionRepo.isInCooldown(event.contractAddress);
				return inCooldown ? EventSeverity.HIGH : EventSeverity.LOW;
			} catch (error) {
				this.logger.warn(`Failed to determine cooldown status for MintingUpdate: ${error.message}`);
			}
		}

		return severity;
	}

	private formatTimestamp(timestamp: bigint): string {
		const date = new Date(Number(timestamp) * 1000);
		const time = date.toTimeString().slice(0, 8);
		const day = date.toDateString().slice(4, 10);
		return `${day} at ${time} UTC`;
	}

	private formatArgs(args: Record<string, any>): string {
		return Object.entries(args)
			.map(([key, value]) => {
				if (typeof value === 'string' && value.startsWith('0x')) {
					return `*${key}:* \`${value}\``; // monospaced for addresses/hashes
				}
				return `*${key}:* ${value}`;
			})
			.join('\n');
	}

	private constructMessage(event: Event, severity: string, time: string): string {
		const severityIndicator = { HIGH: '🚨', MEDIUM: '', LOW: '' }[severity] || '';
		const argsText = this.formatArgs(event.args);

		const lines = [
			`${severityIndicator} *${event.topic.replace(/([A-Z])/g, ' $1').trim()}*`,
			'',
			severity ? `Severity: *${severity}*` : null,
			`Time: ${time}`,
			'',
			argsText,
			'',
			`[View on Explorer →](${this.explorerBaseUrl}/tx/${event.txHash})`,
		].filter((line) => line !== null);

		return lines.join('\n');
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
