import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Event } from './types';
import { EVENT_CONFIG, EventSeverity } from './events.config';
import { PositionRepository } from './prisma/repositories/position.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { AppConfigService } from 'src/config/config.service';
import TelegramBot from 'node-telegram-bot-api';
import { promises as fs } from 'fs';

interface TelegramGroupState {
	apiVersion: string;
	createdAt: number;
	updatedAt: number;
	groups: string[];
}

const COMMAND_HANDLES = ['/start', '/subscribe', '/unsubscribe', '/help'];

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(TelegramService.name);
	private readonly botToken: string;
	private readonly groupsJsonPath: string | undefined;
	private readonly enabled: boolean;
	private bot: TelegramBot | undefined;
	private groupState: TelegramGroupState = { apiVersion: '1.0.0', createdAt: 0, updatedAt: 0, groups: [] };

	constructor(
		private readonly config: AppConfigService,
		private readonly positionRepo: PositionRepository,
		private readonly eventsRepo: EventsRepository
	) {
		this.botToken = this.config.telegramBotToken;
		this.groupsJsonPath = this.config.telegramGroupsJson;
		this.enabled = this.config.telegramAlertsEnabled && !!this.botToken && !!this.groupsJsonPath;
		this.logger.log(`Telegram notifications are ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
	}

	async onModuleInit(): Promise<void> {
		if (!this.enabled) return;
		await this.loadGroupState();
		this.bot = new TelegramBot(this.botToken, { polling: true });
		this.applyListener();
		this.logger.log(`Telegram bot polling started (${this.groupState.groups.length} subscriber(s))`);
	}

	async onModuleDestroy(): Promise<void> {
		if (this.bot) {
			await this.bot.stopPolling().catch(() => undefined);
		}
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
			return await this.broadcast(message);
		} catch (error) {
			this.logger.error(`Failed to send Telegram message for event ${event.topic}: ${error.message}`);
			return false;
		}
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
	 * Deliver to every subscribed chat. Returns true iff at least one delivery succeeded;
	 * per-chat failures (user blocked the bot, chat deleted, transient API error) are logged
	 * and skipped so a single bad chat does not suppress the entire alert. Disabled bot
	 * (config / no token / no subscribers) returns false.
	 */
	private async broadcast(text: string): Promise<boolean> {
		if (!this.enabled || !this.bot || this.groupState.groups.length === 0) return false;

		let anyDelivered = false;
		for (const chatId of this.groupState.groups) {
			try {
				await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
				anyDelivered = true;
			} catch (error) {
				this.logger.warn(`Telegram delivery to chat ${chatId} failed: ${error.message ?? error}`);
			}
			await this.sleep(50); // stay under per-bot rate limit (~30 msg/s)
		}
		return anyDelivered;
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
	 * Send a critical alert to every subscriber. Returns true only on confirmed delivery to
	 * at least one chat. Returns false when telegram is disabled, no subscribers exist, or
	 * every send failed — callers can then decide not to persist "alerted" state and retry
	 * on the next cycle.
	 */
	async sendCriticalAlert(message: string): Promise<boolean> {
		if (!this.enabled) return false;

		const formattedMessage = `🚨 ${this.envTag()} *CRITICAL ALERT*\n\n${message}\n\n_Timestamp: ${new Date().toISOString()}_`;
		const delivered = await this.broadcast(formattedMessage);
		if (delivered) this.logger.log('Critical alert sent via Telegram');
		return delivered;
	}

	// --- Subscriber management ---------------------------------------------------------

	private applyListener(): void {
		if (!this.bot) return;
		this.bot.on('message', async (msg) => {
			const text = msg.text;
			if (!text || !COMMAND_HANDLES.includes(text)) return;
			const chatId = msg.chat.id.toString();
			switch (text) {
				case '/start':
				case '/subscribe':
					await this.handleSubscribe(chatId);
					break;
				case '/unsubscribe':
					await this.handleUnsubscribe(chatId);
					break;
				case '/help':
					await this.handleHelp(chatId);
					break;
			}
		});
		this.bot.on('polling_error', (err) => {
			this.logger.warn(`Polling error: ${err.message ?? err}`);
		});
	}

	private async handleSubscribe(chatId: string): Promise<void> {
		if (this.groupState.groups.includes(chatId)) {
			await this.bot?.sendMessage(chatId, 'You are already subscribed.');
			return;
		}
		this.groupState.groups.push(chatId);
		await this.writeGroupState();
		await this.bot?.sendMessage(chatId, 'You are now subscribed. Use /unsubscribe to stop.');
		this.logger.log(`Subscribed chat ${chatId} (total: ${this.groupState.groups.length})`);
	}

	private async handleUnsubscribe(chatId: string): Promise<void> {
		if (!this.groupState.groups.includes(chatId)) {
			await this.bot?.sendMessage(chatId, 'You are not subscribed.');
			return;
		}
		this.groupState.groups = this.groupState.groups.filter((g) => g !== chatId);
		await this.writeGroupState();
		await this.bot?.sendMessage(chatId, 'You are not subscribed anymore.');
		this.logger.log(`Unsubscribed chat ${chatId} (total: ${this.groupState.groups.length})`);
	}

	private async handleHelp(chatId: string): Promise<void> {
		const lines = [
			'*Available commands:*',
			'/start or /subscribe — receive alerts in this chat',
			'/unsubscribe — stop receiving alerts',
			'/help — show this message',
		];
		await this.bot?.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
	}

	private async loadGroupState(): Promise<void> {
		if (!this.groupsJsonPath) return;
		try {
			const raw = await fs.readFile(this.groupsJsonPath, 'utf-8');
			const parsed: TelegramGroupState = JSON.parse(raw);
			this.groupState = {
				apiVersion: parsed.apiVersion ?? '1.0.0',
				createdAt: parsed.createdAt ?? 0,
				updatedAt: parsed.updatedAt ?? 0,
				groups: Array.isArray(parsed.groups) ? parsed.groups : [],
			};
		} catch (err: any) {
			if (err?.code !== 'ENOENT') {
				this.logger.warn(`Could not read groups file ${this.groupsJsonPath}: ${err.message ?? err}`);
			}
			// Fresh state — first start, will be created on first subscribe
			this.groupState = { apiVersion: '1.0.0', createdAt: Date.now(), updatedAt: Date.now(), groups: [] };
		}
	}

	private async writeGroupState(): Promise<void> {
		if (!this.groupsJsonPath) return;
		this.groupState.updatedAt = Date.now();
		if (!this.groupState.createdAt) this.groupState.createdAt = Date.now();
		try {
			await fs.writeFile(this.groupsJsonPath, JSON.stringify(this.groupState), 'utf-8');
		} catch (err: any) {
			this.logger.error(`Failed to persist groups file ${this.groupsJsonPath}: ${err.message ?? err}`);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
