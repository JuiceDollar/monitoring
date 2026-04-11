import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { Token } from '../../types';

@Injectable()
export class TokenRepository {
	private readonly logger = new Logger(TokenRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async createMany(tokens: Token[]): Promise<void> {
		if (tokens.length === 0) return;

		await this.prisma.token.createMany({
			data: tokens.map((token) => ({
				...token,
				address: token.address.toLowerCase(),
				decimals: token.decimals !== undefined ? Number(token.decimals) : undefined,
			})),
			skipDuplicates: true,
		});

		this.logger.log(`Successfully persisted ${tokens.length} tokens`);
	}

	async updatePrices(priceUpdates: { address: string; price: string }[]): Promise<void> {
		if (priceUpdates.length === 0) return;

		const now = new Date();
		await this.prisma.$transaction(
			priceUpdates.map((update) =>
				this.prisma.token.update({
					where: { address: update.address.toLowerCase() },
					data: {
						price: update.price,
						timestamp: now,
					},
				})
			)
		);

		this.logger.log(`Updated prices for ${priceUpdates.length} tokens`);
	}

	async findAll(): Promise<Token[]> {
		return this.prisma.token.findMany();
	}
}
