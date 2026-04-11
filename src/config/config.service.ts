import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonitoringConfig } from './monitoring.config';

@Injectable()
export class AppConfigService {
	private readonly logger = new Logger(AppConfigService.name);
	private readonly monitoringConfig: MonitoringConfig;

	constructor(private readonly configService: ConfigService) {
		this.monitoringConfig = this.configService.get<MonitoringConfig>('monitoring');
		if (!this.monitoringConfig) throw new Error('Monitoring configuration not found');
		this.logger.log(`Configuration service initialized: ${JSON.stringify(this.monitoringConfig)}`);
	}

	get rpcUrl(): string {
		return this.monitoringConfig.rpcUrl;
	}

	get blockchainId(): number {
		return this.monitoringConfig.blockchainId;
	}

	get deploymentBlock(): number {
		return this.monitoringConfig.deploymentBlock;
	}

	get blockPerBatch(): number {
		return this.monitoringConfig.blockPerBatch || 500;
	}

	get databaseUrl(): string | undefined {
		return this.monitoringConfig.databaseUrl;
	}

	get pgMaxClients(): number {
		return this.monitoringConfig.pgMaxClients || 10;
	}

	get allowedOrigins(): string | undefined {
		return this.monitoringConfig.allowedOrigins;
	}

	get priceCacheTtlMs(): number {
		return this.monitoringConfig.priceCacheTtlMs || 120000;
	}

	get rpcTimeoutMs(): number {
		return this.monitoringConfig.rpcTimeoutMs || 60000;
	}

	get telegramBotToken(): string | undefined {
		return this.monitoringConfig.telegramBotToken;
	}

	get telegramChatId(): string | undefined {
		return this.monitoringConfig.telegramChatId;
	}

	get telegramAlertsEnabled(): boolean {
		return this.monitoringConfig.telegramAlertsEnabled || false;
	}

	get alertTimeframeHours(): number {
		return this.monitoringConfig.alertTimeframeHours || 12;
	}

	get coingeckoApiKey(): string | undefined {
		return this.monitoringConfig.coingeckoApiKey || undefined;
	}
}
