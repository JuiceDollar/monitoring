import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { ChallengeState } from '../../types';

@Injectable()
export class ChallengeRepository {
	private readonly logger = new Logger(ChallengeRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async createMany(challenges: Partial<ChallengeState>[]): Promise<void> {
		if (challenges.length === 0) return;

		await this.prisma.$transaction(
			challenges.map((c) =>
				this.prisma.challengeState.create({
					data: {
						challengeId: c.challengeId!,
						hubAddress: c.hubAddress!.toLowerCase(),
						challengerAddress: c.challengerAddress!.toLowerCase(),
						positionAddress: c.positionAddress!.toLowerCase(),
						startTimestamp: c.startTimestamp!,
						initialSize: c.initialSize!.toString(),
						size: c.size!.toString(),
						currentPrice: c.currentPrice!.toString(),
						timestamp: c.timestamp!,
					},
				})
			)
		);

		this.logger.log(`Successfully created ${challenges.length} new challenge states`);
	}

	async updateMany(challenges: Partial<ChallengeState>[]): Promise<void> {
		if (challenges.length === 0) return;

		await this.prisma.$transaction(
			challenges.map((c) =>
				this.prisma.challengeState.update({
					where: {
						challengeId_hubAddress: {
							challengeId: c.challengeId!,
							hubAddress: c.hubAddress!.toLowerCase(),
						},
					},
					data: {
						size: c.size!.toString(),
						currentPrice: c.currentPrice!.toString(),
						timestamp: c.timestamp!,
					},
				})
			)
		);

		this.logger.log(`Successfully updated ${challenges.length} existing challenge states`);
	}

	async findAllChallengeKeys(): Promise<{ challengeId: number; hubAddress: string }[]> {
		const challenges = await this.prisma.challengeState.findMany({
			select: { challengeId: true, hubAddress: true },
		});
		return challenges;
	}

	/**
	 * Active challenges (size > 0) joined with their position's challengePeriod.
	 * Returns one row per active challenge with the data the deadline watchdog needs.
	 */
	async findActiveWithChallengePeriod(): Promise<
		Array<{
			challengeId: number;
			hubAddress: string;
			challengerAddress: string;
			positionAddress: string;
			startTimestamp: bigint;
			size: bigint;
			currentPrice: bigint;
			t24Alerted: boolean;
			t2Alerted: boolean;
			challengePeriod: bigint;
		}>
	> {
		const rows = await this.prisma.$queryRaw<
			Array<{
				challenge_id: number;
				hub_address: string;
				challenger_address: string;
				position_address: string;
				start_timestamp: bigint;
				size: any;
				current_price: any;
				t24_alerted: boolean;
				t2_alerted: boolean;
				challenge_period: bigint | null;
			}>
		>`
			SELECT c.challenge_id, c.hub_address, c.challenger_address, c.position_address,
			       c.start_timestamp, c.size, c.current_price, c.t24_alerted, c.t2_alerted,
			       p.challenge_period
			FROM challenge_states c
			LEFT JOIN position_states p ON p.address = c.position_address
			WHERE c.size > 0
		`;
		const result: Array<{
			challengeId: number;
			hubAddress: string;
			challengerAddress: string;
			positionAddress: string;
			startTimestamp: bigint;
			size: bigint;
			currentPrice: bigint;
			t24Alerted: boolean;
			t2Alerted: boolean;
			challengePeriod: bigint;
		}> = [];
		for (const r of rows) {
			if (r.challenge_period === null) {
				this.logger.warn(
					`Active challenge #${r.challenge_id} on ${r.hub_address} references unknown position ${r.position_address}; skipped`
				);
				continue;
			}
			result.push({
				challengeId: r.challenge_id,
				hubAddress: r.hub_address,
				challengerAddress: r.challenger_address,
				positionAddress: r.position_address,
				startTimestamp: BigInt(r.start_timestamp),
				size: BigInt(r.size.toString()),
				currentPrice: BigInt(r.current_price.toString()),
				t24Alerted: r.t24_alerted,
				t2Alerted: r.t2_alerted,
				challengePeriod: BigInt(r.challenge_period),
			});
		}
		return result;
	}

	async markT24Alerted(challengeId: number, hubAddress: string): Promise<void> {
		await this.prisma.challengeState.update({
			where: { challengeId_hubAddress: { challengeId, hubAddress: hubAddress.toLowerCase() } },
			data: { t24Alerted: true },
		});
	}

	async markT2Alerted(challengeId: number, hubAddress: string): Promise<void> {
		await this.prisma.challengeState.update({
			where: { challengeId_hubAddress: { challengeId, hubAddress: hubAddress.toLowerCase() } },
			data: { t2Alerted: true },
		});
	}
}
