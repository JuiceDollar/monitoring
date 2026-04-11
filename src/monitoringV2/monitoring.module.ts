import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ProviderService } from './provider.service';
import { PrismaClientService } from './prisma/client.service';
import { EventsRepository } from './prisma/repositories/events.repository';
import { SyncStateRepository } from './prisma/repositories/sync-state.repository';
import { ContractRepository } from './prisma/repositories/contract.repository';
import { TokenRepository } from './prisma/repositories/token.repository';
import { PositionRepository } from './prisma/repositories/position.repository';
import { ChallengeRepository } from './prisma/repositories/challenge.repository';
import { CollateralRepository } from './prisma/repositories/collateral.repository';
import { MinterRepository } from './prisma/repositories/minter.repository';
import { JusdRepository } from './prisma/repositories/jusd.repository';
import { ContractService } from './contract.service';
import { EventService } from './event.service';
import { TokenService } from './token.service';
import { PositionService } from './position.service';
import { ChallengeService } from './challenge.service';
import { CollateralService } from './collateral.service';
import { MinterService } from './minter.service';
import { JusdService } from './jusd.service';
import { MonitoringService } from './monitoring.service';
import { PriceService } from './price.service';
import { TelegramService } from './telegram.service';
import { ApiModule } from './api/api.module';

@Module({
	imports: [ApiModule],
	providers: [
		AppConfigService,
		ProviderService,
		PrismaClientService,
		PriceService,
		EventsRepository,
		SyncStateRepository,
		ContractRepository,
		TokenRepository,
		PositionRepository,
		ChallengeRepository,
		CollateralRepository,
		MinterRepository,
		JusdRepository,
		ContractService,
		EventService,
		TokenService,
		PositionService,
		ChallengeService,
		CollateralService,
		MinterService,
		JusdService,
		TelegramService,
		MonitoringService,
	],
	exports: [MonitoringService, ContractService, EventService, ApiModule],
})
export class MonitoringV2Module {}
