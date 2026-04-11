import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { MinterState } from '../../types';

@Injectable()
export class MinterRepository {
	private readonly logger = new Logger(MinterRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async findAll(): Promise<MinterState[]> {
		const minters = await this.prisma.minterState.findMany();
		return minters.map((m) => ({
			address: m.address,
			type: m.type as any,
			applicationTimestamp: m.applicationTimestamp,
			applicationPeriod: m.applicationPeriod,
			applicationFee: m.applicationFee ? BigInt(m.applicationFee.toFixed(0)) : BigInt(0),
			message: m.message || '',
			bridgeToken: m.bridgeToken || undefined,
			bridgeHorizon: m.bridgeHorizon || undefined,
			bridgeLimit: m.bridgeLimit ? BigInt(m.bridgeLimit.toFixed(0)) : undefined,
			bridgeMinted: m.bridgeMinted ? BigInt(m.bridgeMinted.toFixed(0)) : undefined,
			status: m.status as any,
			timestamp: m.timestamp,
		}));
	}

	async upsertMany(minters: MinterState[]): Promise<void> {
		if (minters.length === 0) return;

		await this.prisma.$transaction(
			minters.map((m) =>
				this.prisma.minterState.upsert({
					where: { address: m.address.toLowerCase() },
					create: {
						address: m.address.toLowerCase(),
						type: m.type,
						applicationTimestamp: m.applicationTimestamp,
						applicationPeriod: m.applicationPeriod,
						applicationFee: m.applicationFee.toString(),
						message: m.message || null,
						bridgeToken: m.bridgeToken?.toLowerCase() || null,
						bridgeHorizon: m.bridgeHorizon || null,
						bridgeLimit: m.bridgeLimit ? m.bridgeLimit.toString() : null,
						bridgeMinted: m.bridgeMinted ? m.bridgeMinted.toString() : null,
						status: m.status,
						timestamp: m.timestamp,
					},
					update: {
						status: m.status,
						bridgeMinted: m.bridgeMinted ? m.bridgeMinted.toString() : null,
						timestamp: m.timestamp,
					},
				})
			)
		);

		this.logger.log(`Successfully upserted ${minters.length} minter states`);
	}
}
