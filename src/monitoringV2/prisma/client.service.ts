import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaClientService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(PrismaClientService.name);

	constructor() {
		super({
			log: ['error', 'warn'],
			errorFormat: 'pretty',
			datasources: {
				db: {
					url: process.env.DATABASE_URL + '?pgbouncer=true&schema=public', // TODO: review for production on Azure!
				},
			},
		});
	}

	async onModuleInit() {
		try {
			await this.$connect();
			this.logger.log('Prisma client connected successfully');
		} catch (error) {
			this.logger.error('Failed to connect to database:', error);
			throw error;
		}
	}

	async onModuleDestroy() {
		try {
			await this.$disconnect();
			this.logger.log('Prisma client disconnected');
		} catch (error) {
			this.logger.error('Error disconnecting from database:', error);
		}
	}
}
