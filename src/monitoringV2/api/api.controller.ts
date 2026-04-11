import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaClientService } from '../prisma/client.service';
import {
	ChallengeResponse,
	ChallengeStatus,
	CollateralResponse,
	HealthResponse,
	PositionResponse,
	PositionStatus,
	MinterResponse,
	MinterStatus,
	MinterType,
	HealthState,
} from '../../../shared/types';
import type { Token, PositionState } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ProviderService } from '../provider.service';
import { MonitoringService } from '../monitoring.service';
import { AppConfigService } from 'src/config/config.service';

const jusdDecimals = 18;

@ApiTags('Monitoring')
@Controller()
export class ApiController {
	constructor(
		private readonly prisma: PrismaClientService,
		private readonly providerService: ProviderService,
		private readonly monitoringService: MonitoringService,
		private readonly config: AppConfigService
	) {}

	@Get('health')
	@ApiOperation({ summary: 'Get service health status' })
	@ApiResponse({ status: 200, description: 'Service health information' })
	async health(): Promise<HealthResponse> {
		const syncState = await this.prisma.syncState.findFirst();
		const lastProcessedBlock = Number(syncState?.lastProcessedBlock || this.config.deploymentBlock);
		const lastCompletedBlock = Number(syncState?.lastCompletedBlock || this.config.deploymentBlock);
		const consecutiveFailures = this.monitoringService.getConsecutiveFailures();
		const currentBlock = await this.providerService.getBlockNumber().catch(() => undefined);

		return {
			status: consecutiveFailures >= 3 ? HealthState.FAILING : HealthState.OK,
			consecutiveFailures,
			lastProcessedBlock,
			lastCompletedBlock,
			currentBlock,
			blocksBehind: currentBlock !== undefined ? currentBlock - lastCompletedBlock : undefined,
			updatedAt: syncState?.timestamp?.getTime().toString() || '0',
			rpcStats: this.providerService.getRpcStats(),
		};
	}

	@Get('positions')
	@ApiOperation({ summary: 'Get all positions' })
	@ApiResponse({ status: 200, description: 'List of all positions with current state' })
	async getPositions(): Promise<PositionResponse[]> {
		const positions = await this.prisma.positionState.findMany();
		const tokens = await this.prisma.token.findMany();
		const tokenMap = new Map<string, Token>(tokens.map((t) => [t.address.toLowerCase(), t]));

		const deuroDivisor = new Decimal(10).pow(jusdDecimals);

		return positions.map((p) => {
			const token = tokenMap.get(p.collateral.toLowerCase());
			const collateralDecimals = token?.decimals || 18;
			const pricePrecision = 36 - collateralDecimals;

			const collateralDivisor = new Decimal(10).pow(collateralDecimals);
			const priceDivisor = new Decimal(10).pow(pricePrecision);

			const marketPrice = token?.price ? Number(token.price.toString()) : 0;
			const formattedVirtualPrice = Number(p.virtualPrice.div(priceDivisor).toString());
			const collateralizationRatio =
				formattedVirtualPrice > 0 && marketPrice > 0 ? ((marketPrice / formattedVirtualPrice) * 100).toFixed(2) : '0';

			const currentTime = Math.floor(Date.now() / 1000);
			const status = p.isDenied
				? PositionStatus.DENIED
				: currentTime < Number(p.startTimestamp)
					? PositionStatus.PROPOSED
					: p.isClosed
						? PositionStatus.CLOSED
						: p.challengedAmount.toFixed(0) !== '0'
							? PositionStatus.CHALLENGED
							: Number(collateralizationRatio) < 100
								? PositionStatus.UNDERCOLLATERALIZED
								: Number(p.cooldown) > currentTime
									? PositionStatus.COOLDOWN
									: Number(p.expiration) <= currentTime
										? PositionStatus.EXPIRED
										: PositionStatus.OPEN;

			return {
				address: p.address,
				status,
				owner: p.owner,
				original: p.original,
				collateral: p.collateral,
				collateralSymbol: token?.symbol || 'UNKNOWN',
				collateralBalance: p.collateralAmount.div(collateralDivisor).toString(),
				minimumCollateral: p.minimumCollateral.div(collateralDivisor).toString(),
				price: p.price.div(priceDivisor).toString(),
				virtualPrice: formattedVirtualPrice.toString(),
				expiredPurchasePrice: p.expiredPurchasePrice.div(priceDivisor).toString(),
				collateralRequirement: p.collateralRequirement.div(deuroDivisor).toString(),
				debt: p.debt.div(deuroDivisor).toString(),
				interest: p.interest.div(deuroDivisor).toString(),
				principal: p.principal.div(deuroDivisor).toString(),
				limitAmount: p.limit.div(deuroDivisor).toString(),
				availableForMinting: p.availableForMinting.div(deuroDivisor).toString(),
				availableForClones: p.availableForClones.div(deuroDivisor).toString(),
				challengedAmount: p.challengedAmount.div(deuroDivisor).toString(),
				riskPremiumPpm: p.riskPremiumPpm,
				reserveContribution: p.reserveContribution,
				fixedAnnualRatePpm: p.fixedAnnualRatePpm,
				start: (Number(p.startTimestamp) * 1000).toString(),
				cooldown: (Number(p.cooldown) * 1000).toString(),
				expiration: (Number(p.expiration) * 1000).toString(),
				challengePeriod: p.challengePeriod.toString(),
				isClosed: p.isClosed,
				created: (Number(p.created) * 1000).toString(),
				marketPrice: marketPrice.toString(),
				collateralizationRatio: collateralizationRatio,
			};
		});
	}

	@Get('challenges')
	@ApiOperation({ summary: 'Get all challenges' })
	@ApiResponse({ status: 200, description: 'List of all active and completed challenges' })
	async getChallenges(): Promise<ChallengeResponse[]> {
		// TODO (later): Create custom Prisma query tokens, positions and challenges in one go
		const tokens = await this.prisma.token.findMany();
		const tokenMap = new Map<string, Token>(tokens.map((t) => [t.address.toLowerCase(), t]));
		const positions = await this.prisma.positionState.findMany();
		const positionMap = new Map<string, PositionState>(positions.map((p) => [p.address.toLowerCase(), p]));
		const challenges = await this.prisma.challengeState.findMany({ orderBy: { startTimestamp: 'desc' } });

		return challenges.map((c) => {
			const position = positionMap.get(c.positionAddress.toLowerCase());
			const token = position ? tokenMap.get(position.collateral.toLowerCase()) : undefined;
			const collateralDecimals = token?.decimals || 18;
			const pricePrecision = 36 - collateralDecimals;

			const collateralDivisor = new Decimal(10).pow(collateralDecimals);
			const priceDivisor = new Decimal(10).pow(pricePrecision);

			const currentTime = Math.floor(Date.now() / 1000);
			const challengePeriod = position ? Number(position.challengePeriod.toString()) : 0;
			const auctionStart = c.startTimestamp + BigInt(challengePeriod);
			const auctionEnd = auctionStart + BigInt(challengePeriod);
			const status =
				c.size.toFixed(0) === '0' || currentTime > Number(auctionEnd)
					? ChallengeStatus.ENDED
					: currentTime < Number(auctionStart)
						? ChallengeStatus.AVERTING
						: ChallengeStatus.AUCTION;

			return {
				id: c.challengeId,
				hubAddress: c.hubAddress,
				challenger: c.challengerAddress,
				position: c.positionAddress,
				initialSize: c.initialSize.div(collateralDivisor).toString(),
				size: c.size.div(collateralDivisor).toString(),
				currentPrice: c.currentPrice.div(priceDivisor).toString(),
				start: (Number(c.startTimestamp) * 1000).toString(),
				liquidationPrice: position ? position.virtualPrice.div(priceDivisor).toString() : '0',
				collateral: position?.collateral || '0x0',
				collateralSymbol: token?.symbol || 'UNKNOWN',
				collateralBalance: position && token ? position.collateralAmount.div(collateralDivisor).toString() : '0',
				challengePeriod: challengePeriod.toString(),
				status,
			};
		});
	}

	@Get('collateral')
	@ApiOperation({ summary: 'Get collateral summary by token' })
	@ApiResponse({ status: 200, description: 'Aggregated collateral statistics by token type' })
	async getCollateral(): Promise<CollateralResponse[]> {
		const tokens = await this.prisma.token.findMany();
		const collaterals = await this.prisma.collateralState.findMany();
		const tokenMap = new Map<string, Token>(tokens.map((t) => [t.address.toLowerCase(), t]));

		const deuroDivisor = new Decimal(10).pow(jusdDecimals);

		return collaterals.map((c) => {
			const token = tokenMap.get(c.tokenAddress.toLowerCase());
			const tokenMarketPrice = token?.price ? Number(token.price.toString()) : 0;
			const collateralDivisor = new Decimal(10).pow(token?.decimals || 18);

			return {
				collateral: c.tokenAddress,
				symbol: token?.symbol || 'UNKNOWN',
				price: tokenMarketPrice.toString(),
				totalCollateral: c.totalCollateral.div(collateralDivisor).toString(),
				totalLimit: c.totalLimit.div(deuroDivisor).toString(),
				totalAvailableForMinting: c.totalAvailableForMinting.div(deuroDivisor).toString(),
				positionCount: c.positionCount,
				updatedAt: c.timestamp.getTime().toString(),
			};
		});
	}

	@Get('jusd')
	@ApiOperation({ summary: 'Get JUSD protocol state' })
	@ApiResponse({ status: 200, description: 'Global JuiceDollar (JUSD) protocol metrics and state' })
	async getJusdState() {
		const state = await this.prisma.jusdState.findUnique({ where: { id: 1 } });
		if (!state) return null;

		const divisor = new Decimal(10).pow(jusdDecimals);

		return {
			// Token supplies (in JUSD units)
			jusdTotalSupply: state.jusdTotalSupply.div(divisor).toFixed(2),
			juiceTotalSupply: state.juiceTotalSupply.div(divisor).toFixed(2),

			// Equity metrics
			equityShares: state.equityShares.div(divisor).toFixed(2),
			equityPrice: state.equityPrice.div(divisor).toFixed(6),

			// Reserve metrics (in JUSD units)
			reserveTotal: state.reserveTotal.div(divisor).toFixed(2),
			reserveMinter: state.reserveMinter.div(divisor).toFixed(2),
			reserveEquity: state.reserveEquity.div(divisor).toFixed(2),

			// Savings metrics (in JUSD units)
			savingsTotal: state.savingsTotal.div(divisor).toFixed(2),
			savingsInterestCollected: state.savingsInterestCollected.div(divisor).toFixed(2),
			savingsRate: state.savingsRate, // PPM value

			// Profit/Loss tracking (in JUSD units)
			jusdLoss: state.jusdLoss.div(divisor).toFixed(2),
			jusdProfit: state.jusdProfit.div(divisor).toFixed(2),
			jusdProfitDistributed: state.jusdProfitDistributed.div(divisor).toFixed(2),

			// Frontend metrics
			frontendFeesCollected: state.frontendFeesCollected.div(divisor).toFixed(2),
			frontendsActive: state.frontendsActive,

			// 24h metrics
			savingsInterestCollected24h: state.savingsInterestCollected24h.div(divisor).toFixed(2),
			savingsAdded24h: state.savingsAdded24h.div(divisor).toFixed(2),
			savingsWithdrawn24h: state.savingsWithdrawn24h.div(divisor).toFixed(2),
			equityTradeVolume24h: state.equityTradeVolume24h.div(divisor).toFixed(2),
			equityTradeCount24h: state.equityTradeCount24h,
			equityDelegations24h: state.equityDelegations24h,

			// Metadata
			blockNumber: state.blockNumber.toString(),
			timestamp: state.timestamp.getTime().toString(),
		};
	}

	@Get('minters')
	@ApiOperation({ summary: 'Get all minters and bridges' })
	@ApiResponse({ status: 200, description: 'List of all generic minters and bridge contracts' })
	async getMinters(): Promise<MinterResponse[]> {
		const minters = await this.prisma.minterState.findMany();
		const tokens = await this.prisma.token.findMany();
		const tokenMap = new Map<string, Token>(tokens.map((t) => [t.address.toLowerCase(), t]));

		const deuroDivisor = new Decimal(10).pow(jusdDecimals);

		return minters.map((m) => ({
			address: m.address,
			type: m.type as MinterType,
			status: m.status as MinterStatus,
			applicationTimestamp: (Number(m.applicationTimestamp) * 1000).toString(),
			applicationPeriod: m.applicationPeriod.toString(),
			applicationFee: m.applicationFee.div(deuroDivisor).toString(),
			message: m.message || '',

			bridgeToken: m.bridgeToken || undefined,
			bridgeTokenSymbol: tokenMap.get(m.bridgeToken?.toLowerCase() || '')?.symbol || undefined,
			bridgeLimit: m.bridgeLimit ? m.bridgeLimit.div(deuroDivisor).toFixed(2) : undefined,
			bridgeMinted: m.bridgeMinted ? m.bridgeMinted.div(deuroDivisor).toFixed(4) : undefined,
			bridgeHorizon: m.bridgeHorizon ? (Number(m.bridgeHorizon) * 1000).toString() : undefined,
		}));
	}
}
