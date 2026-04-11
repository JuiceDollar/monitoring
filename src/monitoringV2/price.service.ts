import { EquityABI, ADDRESS } from '@juicedollar/jusd';
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { AppConfigService } from 'src/config/config.service';
import { TokenRepository } from './prisma/repositories/token.repository';

interface TokenPrice {
	data: {
		id: string;
		type: string;
		attributes: {
			token_prices: {
				[key: string]: string;
			};
		};
	};
}

interface PriceCacheEntry {
	value: string;
	timestamp: number;
}

@Injectable()
export class PriceService {
	private readonly CACHE_TTL_MS: number;
	private readonly logger = new Logger(PriceService.name);
	private priceCache = new Map<string, PriceCacheEntry>();
	private wcbtcAddresses = new Set<string>();

	constructor(
		private readonly providerService: ProviderService,
		private readonly appConfigService: AppConfigService
	) {
		this.CACHE_TTL_MS = this.appConfigService.priceCacheTtlMs;
	}

	registerWcbtcAddress(address: string): void {
		this.wcbtcAddresses.add(address.toLowerCase());
	}

	private isWcbtc(address: string): boolean {
		return this.wcbtcAddresses.has(address.toLowerCase());
	}

	async getTokenPricesInUsd(addresses: string[]): Promise<{ [key: string]: string }> {
		const equityAddress = ADDRESS[this.appConfigService.blockchainId]?.equity?.toLowerCase();

		const equityAddresses = addresses.filter((addr) => addr.toLowerCase() === equityAddress);
		const wcbtcAddresses = addresses.filter((addr) => this.isWcbtc(addr));
		const standardAddresses = addresses.filter(
			(addr) => addr.toLowerCase() !== equityAddress && !this.isWcbtc(addr)
		);

		const [equityPrices, wcbtcPrices, geckoTerminalPrices] = await Promise.all([
			this.getEquityPrice(equityAddresses),
			this.getWcbtcPrices(wcbtcAddresses),
			this.getGeckoTerminalPricesInUSD(standardAddresses),
		]);

		return { ...geckoTerminalPrices, ...wcbtcPrices, ...equityPrices };
	}

	private async getWcbtcPrices(addresses: string[]): Promise<{ [key: string]: string }> {
		if (addresses.length === 0) return {};

		const cached = this.getFromCache(addresses);
		const remaining = addresses.filter((addr) => !cached[addr]);
		if (remaining.length === 0) return cached;

		const btcPrice = await this.getBtcPriceInUsd();
		if (!btcPrice) return cached;

		const prices: { [key: string]: string } = {};
		for (const addr of remaining) {
			prices[addr] = btcPrice;
			this.setCache(addr, btcPrice);
		}

		return { ...cached, ...prices };
	}

	private async getBtcPriceInUsd(): Promise<string | null> {
		const cached = this.priceCache.get('btc-usd');
		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
			return cached.value;
		}

		try {
			const apiKey = this.appConfigService.coingeckoApiKey;
			const headers: Record<string, string> = { accept: 'application/json' };
			if (apiKey) headers['x-cg-demo-api-key'] = apiKey;

			const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', {
				headers,
				timeout: 10000,
			});

			const price = String(response.data.bitcoin.usd);
			this.priceCache.set('btc-usd', { value: price, timestamp: Date.now() });
			this.logger.log(`BTC price: $${price}`);
			return price;
		} catch (error) {
			this.logger.error(`Failed to fetch BTC price: ${error.message}`);
			return cached?.value ?? null;
		}
	}

	private async getGeckoTerminalPricesInUSD(addresses: string[]): Promise<{ [key: string]: string }> {
		if (addresses.length === 0) return {};

		const cached = this.getFromCache(addresses);
		const remaining = addresses.filter((addr) => !cached[addr]);
		if (remaining.length === 0) return cached;

		try {
			const response = await axios.get<TokenPrice>(
				`https://api.geckoterminal.com/api/v2/simple/networks/citrea/token_price/${remaining.map((a) => a.toLowerCase()).join(',')}`,
				{
					headers: { accept: 'application/json' },
					timeout: 10000,
				}
			);

			const apiPrices = response.data.data.attributes.token_prices;
			const normalizedPrices: { [key: string]: string } = {};
			for (const inputAddress of remaining) {
				const price = apiPrices[inputAddress.toLowerCase()];
				if (price) {
					normalizedPrices[inputAddress] = price;
					this.setCache(inputAddress, price);
				}
			}

			this.logger.log(`Fetched prices for ${Object.keys(normalizedPrices).length} tokens from GeckoTerminal`);
			return { ...cached, ...normalizedPrices };
		} catch (error) {
			this.logger.error('Failed to fetch token prices from GeckoTerminal:', error.message);
			return cached;
		}
	}

	private async getEquityPrice(requestedAddresses: string[]): Promise<{ [key: string]: string }> {
		if (requestedAddresses.length === 0) return {};

		const cached = this.getFromCache(requestedAddresses);
		const remaining = requestedAddresses.filter((addr) => !cached[addr]);
		if (remaining.length === 0) return cached;

		const prices: { [key: string]: string } = {};
		for (const requestedAddress of remaining) {
			try {
				const equityContract = new ethers.Contract(
					ADDRESS[this.appConfigService.blockchainId].equity,
					EquityABI,
					this.providerService.provider
				);
				const nativePrice = await equityContract.price();
				const formattedPrice = ethers.formatUnits(nativePrice, 18);

				prices[requestedAddress] = formattedPrice;
				this.setCache(requestedAddress, formattedPrice);
				this.logger.debug(`Fetched equity price: ${formattedPrice}`);
			} catch (error) {
				this.logger.error(`Failed to fetch equity price: ${error.message}`);
			}
		}

		return { ...cached, ...prices };
	}

	// Cache management methods

	private getFromCache(addresses: string[]): { [key: string]: string } {
		const prices: { [key: string]: string } = {};
		for (const address of addresses) {
			const cached = this.priceCache.get(address.toLowerCase());
			if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
				prices[address] = cached.value;
			}
		}
		return prices;
	}

	private setCache(address: string, price: string): void {
		const cacheKey = address.toLowerCase();
		this.priceCache.set(cacheKey, { value: price, timestamp: Date.now() });
		this.logger.debug(`Cached price for ${address}: ${price}`);
	}
}
