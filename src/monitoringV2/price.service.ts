import { EquityABI, ADDRESS } from '@juicedollar/jusd';
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { AppConfigService } from 'src/config/config.service';

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

	constructor(
		private readonly providerService: ProviderService,
		private readonly appConfigService: AppConfigService
	) {
		this.CACHE_TTL_MS = this.appConfigService.priceCacheTtlMs;
	}

	async getTokenPricesInUsd(addresses: string[]): Promise<{ [key: string]: string }> {
		const equityAddress = ADDRESS[this.appConfigService.blockchainId]?.equity?.toLowerCase();
		const equityAddresses = addresses.filter((addr) => addr.toLowerCase() === equityAddress);
		const standardAddresses = addresses.filter((addr) => addr.toLowerCase() !== equityAddress);

		const [equityPrices, geckoTerminalPrices] = await Promise.all([
			this.getEquityPrice(equityAddresses),
			this.getGeckoTerminalPricesInUSD(standardAddresses),
		]);

		return { ...geckoTerminalPrices, ...equityPrices };
	}

	/**
	 * Fetches token prices from GeckoTerminal API with caching.
	 * Note: Citrea may not be supported by GeckoTerminal yet.
	 * Falls back to cached values or empty results if unavailable.
	 */
	private async getGeckoTerminalPricesInUSD(addresses: string[]): Promise<{ [key: string]: string }> {
		if (addresses.length === 0) return {};

		const cached = this.getFromCache(addresses);
		const remaining = addresses.filter((addr) => !cached[addr]);
		if (remaining.length === 0) {
			this.logger.debug('Returning cached prices for all requested tokens');
			return cached;
		}

		try {
			// Try Citrea network on GeckoTerminal (network slug may vary)
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
			this.logger.error('Failed to fetch token prices from GeckoTerminal:', error);
			if (cached) {
				this.logger.warn('Returning expired cached prices due to API error');
				return cached;
			}

			return {};
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
