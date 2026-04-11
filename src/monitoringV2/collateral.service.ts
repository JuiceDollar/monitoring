import { Injectable, Logger } from '@nestjs/common';
import { PositionRepository } from './prisma/repositories/position.repository';
import { CollateralRepository } from './prisma/repositories/collateral.repository';

@Injectable()
export class CollateralService {
	private readonly logger = new Logger(CollateralService.name);

	constructor(
		private readonly positionRepo: PositionRepository,
		private readonly collateralRepo: CollateralRepository
	) {}

	async syncCollaterals(): Promise<void> {
		const collateralStates = await this.positionRepo.getCollateralSummary();
		if (collateralStates.length === 0) return;

		await this.collateralRepo.upsertMany(collateralStates);
	}
}
