import { Injectable, Logger } from '@nestjs/common';
import { Token } from './types';
import { AppConfigService } from '../config/config.service';
import { ADDRESS, ERC20ABI } from '@juicedollar/jusd';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { TokenRepository } from './prisma/repositories/token.repository';
import { PriceService } from 'src/monitoringV2/price.service';
import { ContractService } from './contract.service';

@Injectable()
export class TokenService {
	private readonly logger = new Logger(TokenService.name);
	private cache = new Map<string, Token>();

	constructor(
		private readonly config: AppConfigService,
		private readonly tokenRepo: TokenRepository,
		private readonly contractService: ContractService,
		private readonly providerService: ProviderService,
		private readonly priceService: PriceService
	) {}

	async initialize(): Promise<void> {
		await this.registerProtocolTokens();
		await this.initializeCache();
	}

	private async initializeCache(): Promise<void> {
		const tokens = await this.tokenRepo.findAll();

		this.cache.clear();
		for (const token of tokens) {
			this.cache.set(token.address.toLowerCase(), token);
			if (token.symbol?.toUpperCase() === 'WCBTC') {
				this.priceService.registerWcbtcAddress(token.address);
			}
		}

		this.logger.log(`Loaded ${this.cache.size} tokens into cache`);
	}

	private async registerProtocolTokens(): Promise<void> {
		const chainId = this.config.blockchainId;

		const protocolTokens: Token[] = [
			{
				address: ADDRESS[chainId].juiceDollar,
				symbol: 'JUSD',
				name: 'JuiceDollar',
				decimals: 18,
			},
			{
				address: ADDRESS[chainId].equity,
				symbol: 'JUICE',
				name: 'JuiceDollar Equity',
				decimals: 18,
			},
		];

		await this.tokenRepo.createMany(protocolTokens);
		this.logger.log(`Registered core protocol tokens`);
	}

	async persistTokens(tokens: Token[]): Promise<void> {
		if (tokens.length === 0) return;

		await this.tokenRepo.createMany(tokens);

		// Update cache
		for (const c of tokens) {
			const formattedAddress = c.address.toLowerCase();
			this.cache.set(formattedAddress, {
				...c,
				address: formattedAddress,
			});
			if (c.symbol?.toUpperCase() === 'WCBTC') {
				this.priceService.registerWcbtcAddress(formattedAddress);
			}
		}
	}

	async syncTokens(): Promise<void> {
		const allTokens = await this.contractService.getTokensFromContracts();
		const newTokens = allTokens.filter((t) => !this.cache.has(t.toLowerCase()));
		if (newTokens.length === 0) return;

		const onChainData = await this.fetchOnChainTokenData(newTokens);
		const formattedNewTokens = newTokens.map((address) => {
			const lowerAddress = address.toLowerCase();
			return {
				address: lowerAddress,
				name: onChainData[lowerAddress]?.name,
				symbol: onChainData[lowerAddress]?.symbol,
				decimals: onChainData[lowerAddress]?.decimals,
			};
		});

		// Persist and update cache
		await this.persistTokens(formattedNewTokens);
		this.logger.log(`Captured ${formattedNewTokens.length} new tokens`);
	}

	async syncPrices(): Promise<void> {
		const tokenAddresses = Array.from(this.cache.keys());
		if (tokenAddresses.length === 0) return;

		try {
			const prices = await this.priceService.getTokenPricesInUsd(tokenAddresses);
			const priceUpdates: { address: string; price: string }[] = [];
			for (const [address, price] of Object.entries(prices)) {
				if (price && price !== '0' && this.cache.has(address.toLowerCase())) {
					priceUpdates.push({ address, price });
				}
			}

			if (priceUpdates.length > 0) await this.tokenRepo.updatePrices(priceUpdates);
		} catch (error) {
			this.logger.error(`Failed to update token prices: ${error.message}`, error.stack);
		}
	}

	private async fetchOnChainTokenData(addresses: string[]): Promise<{ [key: string]: Partial<Token> }> {
		const results: { [key: string]: Partial<Token> } = {};
		const multicallProvider = this.providerService.multicallProvider;

		const calls: Array<() => Promise<any>> = [];
		for (const address of addresses) {
			const contract = new ethers.Contract(address, ERC20ABI, multicallProvider);
			calls.push(() => contract.name());
			calls.push(() => contract.symbol());
			calls.push(() => contract.decimals());
		}

		const responses = await this.providerService.callBatch(calls);
		for (let i = 0; i < addresses.length; i++) {
			const baseIdx = i * 3;
			results[addresses[i].toLowerCase()] = {
				name: responses[baseIdx],
				symbol: responses[baseIdx + 1],
				decimals: responses[baseIdx + 2],
			};
		}

		this.logger.log(`Fetched on-chain token data for ${addresses.length} tokens via multicall`);
		return results;
	}
}
