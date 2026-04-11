import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { CollateralState } from '../../types';

@Injectable()
export class CollateralRepository {
	private readonly logger = new Logger(CollateralRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async upsertMany(collaterals: CollateralState[]): Promise<void> {
		if (collaterals.length === 0) return;

		await this.prisma.$transaction(
			collaterals.map((c) =>
				this.prisma.collateralState.upsert({
					where: { tokenAddress: c.collateral.toLowerCase() },
					create: {
						tokenAddress: c.collateral.toLowerCase(),
						totalCollateral: c.totalCollateral.toString(),
						positionCount: c.positionCount,
						totalLimit: c.totalLimit.toString(),
						totalAvailableForMinting: c.totalAvailableForMinting.toString(),
						timestamp: c.timestamp,
					},
					update: {
						totalCollateral: c.totalCollateral.toString(),
						positionCount: c.positionCount,
						totalLimit: c.totalLimit.toString(),
						totalAvailableForMinting: c.totalAvailableForMinting.toString(),
						timestamp: c.timestamp,
					},
				})
			)
		);

		this.logger.log(`Successfully upserted ${collaterals.length} collateral states`);
	}
}
