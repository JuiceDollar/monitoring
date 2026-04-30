import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ProviderService } from './provider.service';
import { ContractService } from './contract.service';
import { AppConfigService } from 'src/config/config.service';
import { SyncStateRepository } from './prisma/repositories/sync-state.repository';
import { EventService } from './event.service';
import { TokenService } from './token.service';
import { PositionService } from './position.service';
import { ChallengeService } from './challenge.service';
import { CollateralService } from './collateral.service';
import { MinterService } from './minter.service';
import { JusdService } from './jusd.service';
import { TelegramService } from './telegram.service';

@Injectable()
export class MonitoringService implements OnModuleInit {
	private isRunning = false;
	private consecutiveFailures = 0;

	private readonly logger = new Logger(MonitoringService.name);

	constructor(
		private readonly config: AppConfigService,
		private readonly providerService: ProviderService,
		private readonly syncStateRepo: SyncStateRepository,
		private readonly contractService: ContractService,
		private readonly eventCollector: EventService,
		private readonly tokenService: TokenService,
		private readonly positionService: PositionService,
		private readonly challengeService: ChallengeService,
		private readonly collateralService: CollateralService,
		private readonly minterService: MinterService,
		private readonly jusdService: JusdService,
		private readonly telegramService: TelegramService
	) {}

	async onModuleInit() {
		this.logger.log('Monitoring service initialized');
		await this.contractService.initialize();
		await this.tokenService.initialize();
		await this.positionService.initialize();
		await this.challengeService.initialize();
		await this.minterService.initialize();
		await this.jusdService.initialize();
		setTimeout(() => this.runMonitoring(), 5000);
	}

	@Cron(CronExpression.EVERY_5_MINUTES)
	async runMonitoring() {
		if (this.isRunning) {
			this.logger.warn('Monitoring cycle already running, skipping...');
			return;
		}

		this.isRunning = true;

		let currentBlock: number, fromBlock: number;
		try {
			({ fromBlock, currentBlock } = await this.getBlockRangeToProcess());
			if (fromBlock > currentBlock) {
				this.consecutiveFailures = 0;
				return;
			}

			const startTime = Date.now();
			await this.processBlocks(fromBlock, currentBlock);
			this.logger.log(`Monitoring cycle completed in ${Date.now() - startTime}ms`);

			this.consecutiveFailures = 0;
		} catch (error) {
			this.consecutiveFailures++;
			let errorMsg = typeof error?.message === 'string' && error.message;
			if (!errorMsg) {
				try { errorMsg = JSON.stringify(error); }
				catch { errorMsg = String(error); }
			}
			this.logger.error(
				`Error occurred while processing blocks (${this.consecutiveFailures} consecutive failures): ${errorMsg}`,
				error?.stack || error
			);

			if (this.shouldAlertFailure()) {
				try {
					const lastCompletedBlock = await this.syncStateRepo.getLastCompletedBlock();
					const currentBlockNow = await this.providerService.getBlockNumber().catch(() => undefined);
					const currentBlockStr = currentBlockNow !== undefined ? currentBlockNow.toString() : 'unknown';
					const blocksBehind = currentBlockNow !== undefined && lastCompletedBlock !== null
						? currentBlockNow - lastCompletedBlock
						: 'unknown';

					await this.telegramService.sendCriticalAlert(
						`Monitoring system stuck after ${this.consecutiveFailures} consecutive failures!\n\n` +
							`Last processed block: ${lastCompletedBlock ?? 'none'}\n` +
							`Current block: ${currentBlockStr}\n` +
							`Blocks behind: ${blocksBehind}\n\n` +
							`Error: ${errorMsg}`
					);
				} catch (alertError) {
					let alertErrorMsg = typeof alertError?.message === 'string' && alertError.message;
					if (!alertErrorMsg) {
						try { alertErrorMsg = JSON.stringify(alertError); }
						catch { alertErrorMsg = String(alertError); }
					}
					this.logger.error(`Failed to send critical alert: ${alertErrorMsg}`);
				}
			}
		} finally {
			this.isRunning = false;
		}
	}

	getConsecutiveFailures(): number {
		return this.consecutiveFailures;
	}

	private async processBlocks(fromBlock: number, currentBlock: number): Promise<void> {
		let batchStart = fromBlock;
		while (batchStart <= currentBlock) {
			const batchEnd = Math.min(batchStart + this.config.blockPerBatch - 1, currentBlock);
			await this.eventCollector.processEvents(batchStart, batchEnd);
			await this.syncStateRepo.updateLastProcessedBlock(batchEnd);
			batchStart = batchEnd + 1;

			const progress = ((batchEnd - fromBlock + 1) / (currentBlock - fromBlock + 1)) * 100;
			this.logger.log(`Sync progress: ${progress.toFixed(2)}% (${currentBlock - batchEnd} blocks remaining)`);
		}

		// Post-processing after all blocks are handled
		await this.tokenService.syncTokens(); // sync tokens (from positions and bridges)
		await this.tokenService.syncPrices(); // sync token prices
		await this.positionService.syncPositions(); // sync position states
		await this.challengeService.syncChallenges(); // sync challenge states
		await this.challengeService.checkAuctionDeadlines(); // T-24h / T-2h escalation alerts
		await this.collateralService.syncCollaterals(); // sync collateral states
		await this.minterService.syncMinters(); // sync minter states
		await this.jusdService.syncState(); // sync JUSD global state
		// Watchers wrapped individually so a bug in one cannot mask the alerts of the others.
		// A throwing watcher is logged and the cycle continues; the outer try/catch is reserved
		// for genuine sync-pipeline failures that need the consecutive-failures escalation.
		await this.runWatcher('checkMiniLifetimeClones', () => this.positionService.checkMiniLifetimeClones(this.telegramService));
		await this.runWatcher('checkSuspiciousLiqPrice', () => this.positionService.checkSuspiciousLiqPrice(this.telegramService));
		await this.runWatcher('checkExpiringSoon', () => this.positionService.checkExpiringSoon(this.telegramService));
		await this.runWatcher('checkExpired', () => this.positionService.checkExpired(this.telegramService));
		await this.runWatcher('checkExpiredInPhase2', () => this.positionService.checkExpiredInPhase2(this.telegramService));
		await this.telegramService.sendPendingAlerts(); // send pending telegram alerts

		// Mark full cycle as completed
		await this.syncStateRepo.updateLastCompletedBlock(currentBlock);
	}

	private async getBlockRangeToProcess(): Promise<{ fromBlock: number; currentBlock: number }> {
		const lastProcessedBlock = await this.syncStateRepo.getLastProcessedBlock();
		const fromBlock = lastProcessedBlock !== null ? lastProcessedBlock + 1 : this.config.deploymentBlock;
		const currentBlock = await this.providerService.getBlockNumber();
		this.logger.log(`${currentBlock - fromBlock + 1} new blocks to process: ${fromBlock} to ${currentBlock}`);
		return { fromBlock, currentBlock };
	}

	private shouldAlertFailure() {
		return (
			this.consecutiveFailures > 0 &&
			(this.consecutiveFailures === 3 || this.consecutiveFailures === 12 || this.consecutiveFailures % 72 === 0) // ~ 6 hour heartbeat
		);
	}

	/**
	 * Run a watcher with isolated error handling: exceptions are logged with context
	 * and swallowed so the sibling watchers in the same cycle still get to run. The
	 * outer scheduler try/catch is reserved for sync-pipeline failures that warrant
	 * the consecutive-failures escalation; one watcher silently failing should not
	 * trigger the same path or block the others.
	 */
	private async runWatcher(name: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (error) {
			const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
			this.logger.error(`Watcher ${name} failed: ${errorMsg}`, error?.stack || error);
		}
	}
}
