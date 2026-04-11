import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { CollateralState, PositionState } from '../../types';

@Injectable()
export class PositionRepository {
	private readonly logger = new Logger(PositionRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async createMany(positions: Partial<PositionState>[]): Promise<void> {
		if (positions.length === 0) return;

		await this.prisma.$transaction(
			positions.map((p) =>
				this.prisma.positionState.create({
					data: {
						address: p.address!.toLowerCase(),
						limit: p.limit!.toString(),
						owner: p.owner!.toLowerCase(),
						original: p.original!.toLowerCase(),
						collateral: p.collateral!.toLowerCase(),
						minimumCollateral: p.minimumCollateral!.toString(),
						riskPremiumPpm: p.riskPremiumPpm!,
						reserveContribution: p.reserveContribution!,
						challengePeriod: p.challengePeriod!,
						startTimestamp: p.startTimestamp!,
						expiration: p.expiration!,
						created: p.created,
						price: p.price!.toString(),
						virtualPrice: p.virtualPrice!.toString(),
						collateralAmount: p.collateralAmount!.toString(),
						expiredPurchasePrice: p.expiredPurchasePrice!.toString(),
						collateralRequirement: p.collateralRequirement!.toString(),
						principal: p.principal!.toString(),
						interest: p.interest!.toString(),
						debt: p.debt!.toString(),
						fixedAnnualRatePpm: p.fixedAnnualRatePpm!,
						lastAccrual: p.lastAccrual!,
						cooldown: p.cooldown!,
						challengedAmount: p.challengedAmount!.toString(),
						availableForMinting: p.availableForMinting!.toString(),
						availableForClones: p.availableForClones!.toString(),
						isClosed: p.isClosed!,
						isDenied: p.isDenied!,
						timestamp: p.timestamp!,
					},
				})
			)
		);

		this.logger.log(`Successfully created ${positions.length} new position states`);
	}

	async updateMany(positions: Partial<PositionState>[]): Promise<void> {
		if (positions.length === 0) return;

		await this.prisma.$transaction(
			positions.map((p) =>
				this.prisma.positionState.update({
					where: { address: p.address!.toLowerCase() },
					data: {
						price: p.price!.toString(),
						virtualPrice: p.virtualPrice!.toString(),
						collateralAmount: p.collateralAmount!.toString(),
						expiredPurchasePrice: p.expiredPurchasePrice!.toString(),
						collateralRequirement: p.collateralRequirement!.toString(),
						principal: p.principal!.toString(),
						interest: p.interest!.toString(),
						debt: p.debt!.toString(),
						fixedAnnualRatePpm: p.fixedAnnualRatePpm!,
						lastAccrual: p.lastAccrual!,
						cooldown: p.cooldown!,
						challengedAmount: p.challengedAmount!.toString(),
						availableForMinting: p.availableForMinting!.toString(),
						availableForClones: p.availableForClones!.toString(),
						isClosed: p.isClosed!,
						isDenied: p.isDenied!,
						timestamp: p.timestamp!,
					},
				})
			)
		);

		this.logger.log(`Successfully updated ${positions.length} existing position states`);
	}

	async findAddresses(): Promise<string[]> {
		const positions = await this.prisma.positionState.findMany({
			select: { address: true },
		});
		return positions.map((p) => p.address);
	}

	async getPrice(address: string): Promise<string> {
		const position = await this.prisma.positionState.findUnique({
			where: { address: address.toLowerCase() },
			select: { price: true },
		});

		return position?.price.toFixed(0) || '0';
	}

	async isInCooldown(address: string): Promise<boolean> {
		const position = await this.prisma.positionState.findUnique({
			where: { address: address.toLowerCase() },
			select: { cooldown: true },
		});

		if (!position) return false;

		const now = BigInt(Math.floor(Date.now() / 1000));
		return BigInt(position.cooldown) > now;
	}

	async getCollateralSummary(): Promise<CollateralState[]> {
		const result = await this.prisma.$queryRaw<
			Array<{
				collateral: string;
				total_collateral: string;
				position_count: bigint;
				total_limit: string;
				total_available_for_minting: string;
			}>
		>`
			WITH position_families AS (
				-- For each family, calculate metrics from open positions only
				SELECT
					original,
					COUNT(*) FILTER (WHERE is_closed = false) as open_position_count,
					COALESCE(SUM(collateral_amount) FILTER (WHERE is_closed = false), 0) as family_collateral_total
				FROM position_states
				GROUP BY original
				HAVING COUNT(*) FILTER (WHERE is_closed = false) > 0  -- Only families with at least one open position
			)
			SELECT
				LOWER(orig.collateral) as collateral,
				COALESCE(SUM(pf.family_collateral_total), 0)::text as total_collateral,
				COALESCE(SUM(pf.open_position_count), 0)::bigint as position_count,
				COALESCE(SUM(orig.limit), 0)::text as total_limit,
				COALESCE(SUM(orig.available_for_minting), 0)::text as total_available_for_minting
			FROM position_families pf
			JOIN position_states orig ON pf.original = orig.address AND orig.address = orig.original
			-- Join with the ORIGINAL position (where address = original) to get its limit and availableForMinting
			GROUP BY LOWER(orig.collateral)
		`;

		const timestamp = new Date();
		return result.map((row) => ({
			collateral: row.collateral,
			totalCollateral: BigInt(row.total_collateral),
			positionCount: Number(row.position_count),
			totalLimit: BigInt(row.total_limit),
			totalAvailableForMinting: BigInt(row.total_available_for_minting),
			timestamp,
		}));
	}

	async getTotalPositionInterest(): Promise<bigint> {
		const result = await this.prisma.positionState.aggregate({
			where: {
				isClosed: false,
				isDenied: false,
			},
			_sum: {
				interest: true,
			},
		});

		return BigInt(result._sum.interest?.toFixed(0) || '0');
	}
}
