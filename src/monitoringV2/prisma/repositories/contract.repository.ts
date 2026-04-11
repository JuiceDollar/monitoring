import { Injectable, Logger } from '@nestjs/common';
import { PrismaClientService } from '../client.service';
import { Contract, ContractType } from '../../types';

@Injectable()
export class ContractRepository {
	private readonly logger = new Logger(ContractRepository.name);

	constructor(private readonly prisma: PrismaClientService) {}

	async createMany(contracts: Contract[]): Promise<void> {
		if (contracts.length === 0) return;

		try {
			const prismaContracts = contracts.map((contract) => ({
				...contract,
				address: contract.address.toLowerCase(),
				metadata: contract.metadata || {},
			}));

			await this.prisma.contract.createMany({
				data: prismaContracts,
				skipDuplicates: true,
			});

			this.logger.log(`Successfully persisted ${contracts.length} contracts`);
		} catch (error) {
			this.logger.error(`Failed to persist contracts: ${error.message}`);
			throw error;
		}
	}

	async findAll(): Promise<Contract[]> {
		try {
			const contracts = await this.prisma.contract.findMany({
				orderBy: { address: 'asc' },
			});
			return contracts.map(this.mapToContract);
		} catch (error) {
			this.logger.error(`Failed to fetch contracts: ${error.message}`);
			throw error;
		}
	}

	async getContractsByType(type: ContractType): Promise<Contract[]> {
		try {
			const contracts = await this.prisma.contract.findMany({ where: { type } });
			return contracts.map(this.mapToContract);
		} catch (error) {
			this.logger.error(`Failed to fetch contracts of type ${type}: ${error.message}`);
			throw error;
		}
	}

	async getMinterContracts(): Promise<Contract[]> {
		try {
			const contracts = await this.prisma.contract.findMany({
				where: {
					type: {
						in: [
							ContractType.MINTER,
							ContractType.BRIDGE,
							ContractType.SAVINGS,
							ContractType.FRONTEND_GATEWAY,
							ContractType.MINTING_HUB,
							ContractType.ROLLER,
						],
					},
				},
			});
			return contracts.map(this.mapToContract);
		} catch (error) {
			this.logger.error(`Failed to fetch minter contracts: ${error.message}`);
			throw error;
		}
	}

	private mapToContract = (contract: any): Contract => ({
		address: contract.address,
		type: contract.type as ContractType,
		timestamp: contract.timestamp,
		metadata: (contract.metadata as Record<string, any>) || {},
	});
}
