import { Injectable, Logger } from '@nestjs/common';
import { Event } from './types';
import { EVENT_CONFIG, EventSeverity } from './events.config';
import { PositionRepository } from './prisma/repositories/position.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { AppConfigService } from 'src/config/config.service';

@Injectable()
export class TelegramService {
	private readonly logger = new Logger(TelegramService.name);
	private readonly botToken: string;
	private readonly chatIds: string[];
	private readonly enabled: boolean;

	constructor(
		private readonly config: AppConfigService,
		private readonly positionRepo: PositionRepository,
		private readonly eventsRepo: EventsRepository
	) {
		this.botToken = this.config.telegramBotToken;
		this.chatIds = this.config.telegramChatIds ?? [];
		this.enabled = this.config.telegramAlertsEnabled && !!this.botToken && this.chatIds.length > 0;
		this.logger.log(
			`Telegram notifications are ${this.enabled ? 'ENABLED' : 'DISABLED'}` +
				(this.enabled ? ` (${this.chatIds.length} recipient${this.chatIds.length === 1 ? '' : 's'})` : '')
		);
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
				await this.sleep(100); // rate limit
			}
		} catch (error) {
			this.logger.error(`Error in event alert phase: ${error.message}`, error.stack);
		}
	}

	private async notifyEvent(event: Event): Promise<boolean> {
		const config = EVENT_CONFIG[event.topic];
		if (!config || config.enabled === false) return true;

		const severity = await this.getDynamicSeverity(event, config.severity);
		const time = this.formatTimestamp(event.timestamp);
		if (severity === EventSeverity.LOW) return true; // to avoid rehandling in next cycle

		try {
			const message = this.constructMessage(event, severity, time);
			await this.sendMessage(message);
		} catch (error) {
			this.logger.error(`Failed to send Telegram message for event ${event.topic}: ${error.message}`);
			return false;
		}

		return true;
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

	/**
	 * Deliver to every configured chat. Throws on the first failed delivery so the
	 * caller can react identically to the previous single-recipient behaviour. Recipients
	 * are processed sequentially with a small throttle to stay under Telegram's per-bot
	 * rate limit even when bursting alerts to several operators.
	 */
	private async sendMessage(text: string): Promise<void> {
		for (let i = 0; i < this.chatIds.length; i++) {
			const chatId = this.chatIds[i];
			const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10000);
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
			clearTimeout(timeout);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Telegram API error for chat ${chatId}: ${error}`);
			}

			// Throttle between recipients to respect the per-bot rate limit (~30 msg/s).
			if (i < this.chatIds.length - 1) await this.sleep(50);
		}
	}

	// Helper functions

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
		const envTag = this.envTag();
		const argsText = this.formatArgs(event.args);

		const headerParts = [severityIndicator, envTag, `*${event.topic.replace(/([A-Z])/g, ' $1').trim()}*`].filter(
			(part) => part.length > 0
		);

		const lines = [
			headerParts.join(' '),
			'',
			severity ? `Severity: *${severity}*` : null,
			`Time: ${time}`,
			'',
			argsText,
			'',
			`[View on Citreascan →](https://citreascan.com/tx/${event.txHash})`,
		].filter((line) => line !== null);

		return lines.join('\n');
	}

	// Backslash-escaped square brackets so Telegram's Markdown parser renders them literally
	// instead of interpreting `[…]` as the start of a link. Combines tier tag (env) and
	// optional chain — set CHAIN to render e.g. `[PRD] [MAINNET]`, leave unset to
	// render only `[PRD]`. Either side is omitted if the corresponding env var is unset.
	private envTag(): string {
		const env = this.config.environment ? `\\[${this.config.environment.toUpperCase()}\\]` : '';
		const chain = this.config.chain ? `\\[${this.config.chain.toUpperCase()}\\]` : '';
		return [env, chain].filter((part) => part.length > 0).join(' ');
	}

	/**
	 * Send a critical alert. Returns true only on confirmed delivery. Returns false when
	 * telegram is disabled or on Telegram API failure (429, network drop, parse error) so
	 * callers do not persist "alerted" state — positions stay unalerted in the DB and are
	 * retried every cycle until delivery succeeds.
	 */
	async sendCriticalAlert(message: string): Promise<boolean> {
		if (!this.enabled) return false;

		try {
			const formattedMessage = `🚨 ${this.envTag()} *CRITICAL ALERT*\n\n${message}\n\n_Timestamp: ${new Date().toISOString()}_`;
			await this.sendMessage(formattedMessage);
			this.logger.log('Critical alert sent via Telegram');
			return true;
		} catch (error) {
			this.logger.error(`Failed to send critical Telegram alert: ${error.message}`);
			return false;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
