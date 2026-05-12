import { EquityABI, ADDRESS } from '@juicedollar/jusd';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { ethers } from 'ethers';
import { ProviderService } from './provider.service';
import { AppConfigService } from 'src/config/config.service';
import { TelegramService } from './telegram.service';

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

interface CoingeckoEndpoint {
	baseUrl: string;
	headers: Record<string, string>;
}

interface CoingeckoKeyInfo {
	plan?: string;
	monthly_call_credit?: number;
	current_total_monthly_calls?: number;
	current_remaining_monthly_calls?: number;
}

const STALENESS_ALERT_THRESHOLD_MS = 60 * 60 * 1000;
const STALENESS_ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
const QUOTA_REMAINING_ALERT_THRESHOLD = 25_000;
const QUOTA_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PriceService {
	private readonly CACHE_TTL_MS: number;
	private readonly logger = new Logger(PriceService.name);
	private priceCache = new Map<string, PriceCacheEntry>();
	private wcbtcAddresses = new Set<string>();
	// Initialised to container-start time so the staleness watchdog still
	// fires when the very first BTC fetch never succeeds (CoinGecko down at
	// boot, restart-loop). Without this, a `null` initial value would suppress
	// the alert indefinitely.
	private btcLastSuccessMs: number = Date.now();
	private btcStalenessAlertedAt: number | null = null;
	private quotaAlertedAt: number | null = null;

	constructor(
		private readonly providerService: ProviderService,
		private readonly appConfigService: AppConfigService,
		private readonly telegramService: TelegramService
	) {
		this.CACHE_TTL_MS = this.appConfigService.priceCacheTtlMs;
		if (!this.appConfigService.coingeckoBaseUrl) {
			throw new Error('COINGECKO_BASE_URL is not set');
		}
		if (!this.appConfigService.geckoTerminalBaseUrl) {
			throw new Error('GECKOTERMINAL_BASE_URL is not set');
		}
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
		const standardAddresses = addresses.filter((addr) => addr.toLowerCase() !== equityAddress && !this.isWcbtc(addr));

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

	/**
	 * Resolve the CoinGecko endpoint.
	 *
	 * `COINGECKO_BASE_URL` is required and points at the origin the service
	 * talks to — typically the in-cluster pricing-proxy
	 * (https://github.com/DFXswiss/pricing-proxy), but any CoinGecko-compatible
	 * origin works (e.g. `https://pro-api.coingecko.com` or
	 * `https://api.coingecko.com`).
	 *
	 * `COINGECKO_API_KEY` is optional and is attached as the
	 * `x-cg-pro-api-key` header on every request when set. Leave it unset when
	 * talking to the pricing-proxy (the proxy injects its own key) or when
	 * hitting the public host anonymously.
	 */
	private resolveCoingeckoEndpoint(): CoingeckoEndpoint {
		const baseUrl = this.appConfigService.coingeckoBaseUrl;
		if (!baseUrl) {
			throw new Error('COINGECKO_BASE_URL is not set');
		}
		const headers: Record<string, string> = { accept: 'application/json' };
		const apiKey = this.appConfigService.coingeckoApiKey;
		if (apiKey) {
			headers['x-cg-pro-api-key'] = apiKey;
		}
		return { baseUrl, headers };
	}

	private async getBtcPriceInUsd(): Promise<string | null> {
		const cached = this.priceCache.get('btc-usd');
		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
			return cached.value;
		}

		try {
			const { baseUrl, headers } = this.resolveCoingeckoEndpoint();
			const response = await axios.get(`${baseUrl}/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`, {
				headers,
				timeout: 10000,
			});

			const price = String(response.data.bitcoin.usd);
			const now = Date.now();
			this.priceCache.set('btc-usd', { value: price, timestamp: now });
			this.btcLastSuccessMs = now;
			this.btcStalenessAlertedAt = null;
			this.logger.log(`BTC price: $${price}`);
			return price;
		} catch (error) {
			this.logger.error(`Failed to fetch BTC price: ${error.message}`);
			return cached?.value ?? null;
		}
	}

	/**
	 * Hourly probe: when the last successful BTC fetch is older than
	 * STALENESS_ALERT_THRESHOLD_MS, the suspicious-liq-price trigger for WCBTC
	 * collateral is running on stale (or missing) spot — escalate via Telegram.
	 * Self-deduplicates: re-alerts at most every STALENESS_ALERT_REPEAT_MS while
	 * the condition persists, and clears on the next successful fetch.
	 */
	@Cron(CronExpression.EVERY_HOUR)
	async checkBtcStaleness(): Promise<void> {
		const staleness = Date.now() - this.btcLastSuccessMs;
		if (staleness < STALENESS_ALERT_THRESHOLD_MS) return;
		if (this.btcStalenessAlertedAt && Date.now() - this.btcStalenessAlertedAt < STALENESS_ALERT_REPEAT_MS) return;

		this.btcStalenessAlertedAt = Date.now();
		const minutes = Math.round(staleness / 60_000);
		await this.telegramService.sendCriticalAlert(
			`BTC spot has not refreshed for ${minutes} min — suspicious-liq-price trigger ` +
				`for WCBTC positions is running on stale or missing reference.`
		);
	}

	/**
	 * Daily probe of /api/v3/key through the pricing proxy. Emits a critical
	 * alert when the monthly remaining call credit drops below
	 * QUOTA_REMAINING_ALERT_THRESHOLD.
	 */
	@Cron(CronExpression.EVERY_DAY_AT_NOON)
	async checkCoingeckoQuota(): Promise<void> {
		try {
			const { baseUrl, headers } = this.resolveCoingeckoEndpoint();
			const response = await axios.get<CoingeckoKeyInfo>(`${baseUrl}/api/v3/key`, {
				headers,
				timeout: 10000,
			});
			const { current_remaining_monthly_calls: remaining, monthly_call_credit: credit } = response.data;
			if (typeof remaining !== 'number' || typeof credit !== 'number' || credit <= 0) return;

			const pct = Math.round((remaining / credit) * 100);
			this.logger.log(`CoinGecko quota: ${remaining} of ${credit} calls remaining (${pct}%)`);

			if (remaining >= QUOTA_REMAINING_ALERT_THRESHOLD) {
				this.quotaAlertedAt = null;
				return;
			}
			if (this.quotaAlertedAt && Date.now() - this.quotaAlertedAt < QUOTA_ALERT_REPEAT_MS) return;

			this.quotaAlertedAt = Date.now();
			await this.telegramService.sendCriticalAlert(
				`CoinGecko monthly quota almost exhausted: ${remaining.toLocaleString()} of ` +
					`${credit.toLocaleString()} calls remaining (${pct}%).`
			);
		} catch (error) {
			this.logger.warn(`CoinGecko quota probe failed: ${error.message ?? error}`);
		}
	}

	private async getGeckoTerminalPricesInUSD(addresses: string[]): Promise<{ [key: string]: string }> {
		if (addresses.length === 0) return {};

		const cached = this.getFromCache(addresses);
		const remaining = addresses.filter((addr) => !cached[addr]);
		if (remaining.length === 0) return cached;

		const baseUrl = this.appConfigService.geckoTerminalBaseUrl;

		try {
			const response = await axios.get<TokenPrice>(
				`${baseUrl}/api/v2/simple/networks/citrea/token_price/${remaining.map((a) => a.toLowerCase()).join(',')}`,
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
