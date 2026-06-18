import { ethers } from 'ethers';
import { Injectable, Logger } from '@nestjs/common';
// Note: Multicall3 is not deployed on Citrea, so we use the standard provider
// and batch calls sequentially instead of using MulticallWrapper.
import { AppConfigService } from 'src/config/config.service';

class RpcStats {
	private stats = new Map<string, { calls: number; errors: number }>();
	private nextMidnightUtc: number = this.getNextMidnightUtc();

	record(method: string, isError: boolean): void {
		if (Date.now() >= this.nextMidnightUtc) {
			this.stats.clear();
			this.nextMidnightUtc = this.getNextMidnightUtc();
		}

		const stat = this.stats.get(method) || { calls: 0, errors: 0 };
		stat.calls++;
		if (isError) stat.errors++;
		this.stats.set(method, stat);
	}

	getStats(): Record<string, { calls: number; errors: number }> {
		return Object.fromEntries(this.stats);
	}

	private getNextMidnightUtc(): number {
		const tomorrow = new Date();
		tomorrow.setUTCHours(24, 0, 0, 0);
		return tomorrow.getTime();
	}
}

class LoggingJsonRpcProvider extends ethers.JsonRpcProvider {
	constructor(
		url: string,
		private rpcStats: RpcStats,
		timeoutMs?: number
	) {
		const connection = new ethers.FetchRequest(url);
		if (timeoutMs) connection.timeout = timeoutMs;
		super(connection);
	}

	// Handle both single and batch requests
	async _send(payload: any | Array<any>): Promise<any> {
		const payloads = Array.isArray(payload) ? payload : [payload];
		const methods = payloads.map((p) => p?.method ?? 'unknown');

		let isError = false;
		try {
			return await super._send(payload);
		} catch (error) {
			isError = true;
			throw error;
		} finally {
			methods.forEach((method) => this.rpcStats.record(method, isError));
		}
	}
}

@Injectable()
export class ProviderService {
	private static readonly CALLEDATA_LIMIT = 480_000; // 480KB call data limit - safe for Alchemy
	private static readonly SERVER_STATUSES = new Set([500, 502, 503, 504, 520, 522, 524]);
	private static readonly NET_CODES = new Set([
		'ETIMEDOUT',
		'ECONNRESET',
		'ECONNABORTED',
		'ECONNREFUSED',
		'EAI_AGAIN',
		'NETWORK_ERROR',
		'SERVER_ERROR',
		'TIMEOUT',
	]);
	// OS-level socket failures only — deliberately excludes the ethers meta-codes
	// 'SERVER_ERROR'/'NETWORK_ERROR', which ethers also emits for HTTP 429/5xx. Those are
	// remote-side and must NOT trigger a client-side provider recycle (see isConnectionError).
	private static readonly CONNECTION_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EAI_AGAIN']);
	private static readonly TOO_LARGE_PATTERNS = [
		'payload too large',
		'request entity too large',
		'entity too large',
		'data too large',
		'max content length',
		'request size exceeded',
		'oversized',
	];
	private static readonly DETERMINISTIC_PATTERNS = ['execution reverted', 'call exception', 'invalid argument', 'method not found'];
	private static readonly RATE_LIMIT_PATTERNS = ['too many requests', 'rate limit'];
	private static readonly NETWORK_PATTERNS = [
		'timeout',
		'timed out',
		'temporarily unavailable',
		'overloaded',
		'socket hang up',
		'connection reset',
		'connection closed',
		'connection aborted',
		'network error',
		'dns',
	];

	private readonly logger = new Logger(ProviderService.name);
	private ethersProvider: ethers.JsonRpcProvider;
	private multicallProviderInstance: ethers.JsonRpcProvider;
	private blockCache = new Map<number, ethers.Block>();
	private rpcStats = new RpcStats();

	constructor(private readonly config: AppConfigService) {
		this.initializeProvider();
	}

	private initializeProvider() {
		this.ethersProvider = new LoggingJsonRpcProvider(this.config.rpcUrl, this.rpcStats, this.config.rpcTimeoutMs);
		this.logger.log(
			`LoggingJsonRpcProvider initialized with _send() override for RPC call tracking (timeout: ${this.config.rpcTimeoutMs}ms)`
		);
		this.multicallProviderInstance = this.ethersProvider;
		this.logger.log(`Provider initialized (no Multicall3 on Citrea, using sequential calls)`);
	}

	/**
	 * Rebuilds the ethers provider (and, on chains with Multicall, the wrapper) from scratch.
	 *
	 * The provider is a long-lived singleton. A connection-level failure ("socket hang up",
	 * ECONNRESET, …) can leave the underlying HTTP/TLS state wedged, and because the sync
	 * services bind their contracts to `multicallProvider`, every subsequent cycle keeps
	 * reusing the same poisoned instance — withRetry alone never escapes it (it re-runs the
	 * same thunks against the same provider). Recycling swaps the singleton so the next call,
	 * and the next cycle's freshly built contracts, start on a clean connection. The block
	 * cache is dropped because its entries were fetched through the discarded provider.
	 */
	private recycleProvider() {
		this.logger.warn('Recycling RPC provider after connection-level failure');
		this.blockCache.clear();
		this.initializeProvider();
	}

	get provider(): ethers.JsonRpcProvider {
		return this.ethersProvider;
	}

	get multicallProvider(): ethers.JsonRpcProvider {
		return this.multicallProviderInstance;
	}

	async callBatch<T>(thunks: Array<() => Promise<T>>, retries = 5): Promise<T[]> {
		const BATCH_SIZE = parseInt(process.env.RPC_BATCH_SIZE || '25');
		const results: T[] = [];

		for (let i = 0; i < thunks.length; i += BATCH_SIZE) {
			const chunk = thunks.slice(i, i + BATCH_SIZE);
			const chunkResults = await this.withRetry(
				() => Promise.all(chunk.map((fn) => fn())),
				{ retries }
			);
			results.push(...chunkResults);
		}

		return results;
	}

	async call<T>(thunk: () => Promise<T>, retries = 5): Promise<T> {
		return this.withRetry(thunk, { retries });
	}

	async getBlock(blockNumber: number): Promise<ethers.Block | null> {
		if (this.blockCache.has(blockNumber)) {
			return this.blockCache.get(blockNumber);
		}

		const block = await this.withRetry(() => this.ethersProvider.getBlock(blockNumber));
		if (block) this.blockCache.set(blockNumber, block);

		if (this.blockCache.size > 1000) {
			const oldestKey = Math.min(...Array.from(this.blockCache.keys()));
			this.blockCache.delete(oldestKey);
		}

		return block;
	}

	async getBlockNumber(): Promise<number> {
		return await this.withRetry(() => this.ethersProvider.getBlockNumber());
	}

	async getLogs(filter: ethers.Filter): Promise<ethers.Log[]> {
		return await this.withRetry(() => this.ethersProvider.getLogs(filter));
	}

	getRpcStats(): Record<string, { calls: number; errors: number }> {
		return this.rpcStats.getStats();
	}

	// Helper functions for retry logic

	// Single source of truth for the error fields both classifiers read — ethers v6 exposes the
	// HTTP status under different keys depending on the path (`status`, `info.responseStatus`,
	// `response.status`), so probe all three to avoid divergence between the two checks.
	private parseError(err: any): { status: number; code: string; msg: string } {
		return {
			status: Number(err?.status ?? err?.info?.responseStatus ?? err?.response?.status ?? NaN),
			code: String(err?.code ?? err?.cause?.code ?? ''),
			msg: String(err?.shortMessage ?? err?.message ?? '').toLowerCase(),
		};
	}

	private isTransientRpcError(err: any): boolean {
		const { status, code, msg } = this.parseError(err);

		const matches = (patterns: string[]) => patterns.some((p) => msg.includes(p));

		if (status === 413 || matches(ProviderService.TOO_LARGE_PATTERNS)) return false;
		if (matches(ProviderService.DETERMINISTIC_PATTERNS)) return false;

		if (status === 429 || code === '429' || matches(ProviderService.RATE_LIMIT_PATTERNS)) return true;
		if (ProviderService.SERVER_STATUSES.has(status)) return true;

		return ProviderService.NET_CODES.has(code) || matches(ProviderService.NETWORK_PATTERNS);
	}

	/**
	 * A connection-level failure where recycling the provider can help — the socket/TLS
	 * state is the suspect. Distinct from remote-side transient errors (HTTP 429/5xx):
	 * those are the server's problem, recreating the client would not change anything and
	 * would only churn connections, so they are retried without a recycle.
	 */
	private isConnectionError(err: any): boolean {
		const { status, code, msg } = this.parseError(err);

		// Exclude remote-side transient errors (HTTP 429 / 5xx) first: recreating the client
		// changes nothing on the server and only churns connections. ethers v6 surfaces these
		// with code 'SERVER_ERROR' and a "server response <status>" message.
		if (status === 429 || ProviderService.SERVER_STATUSES.has(status)) return false;
		if (ProviderService.RATE_LIMIT_PATTERNS.some((p) => msg.includes(p))) return false;
		if (/server response \d{3}/.test(msg)) return false;

		return ProviderService.CONNECTION_CODES.has(code) || ProviderService.NETWORK_PATTERNS.some((p) => msg.includes(p));
	}

	private async withRetry<T>(
		fn: () => Promise<T>,
		options: { retries?: number; baseMs?: number; factor?: number; maxMs?: number } = {}
	): Promise<T> {
		const { retries = 5, baseMs = 200, factor = 2, maxMs = 5000 } = options;
		let attempt = 0;
		let delay = baseMs;
		let recycled = false;

		while (true) {
			try {
				return await fn();
			} catch (err) {
				attempt++;
				if (attempt > retries || !this.isTransientRpcError(err)) {
					this.logger.error(`RPC call failed after ${attempt} attempts: ${err.message}`);
					throw err;
				}

				// On a connection-level failure, swap the provider once before retrying. Provider-direct
				// calls (getLogs/getBlock/getBlockNumber) pick up the fresh connection on their remaining
				// attempts; the sequential sync path recovers on the next cycle, which rebuilds its
				// contracts against the new singleton. Once per withRetry call: a blip must not thrash it.
				if (!recycled && this.isConnectionError(err)) {
					this.recycleProvider();
					recycled = true;
				}

				const jitter = Math.random() * 0.4 + 0.8; // 0.8x–1.2x
				const waitMs = Math.min(delay, maxMs) * jitter;
				this.logger.warn(`RPC call failed (attempt ${attempt}/${retries}), retrying in ${Math.round(waitMs)}ms: ${err.message}`);

				await new Promise((resolve) => setTimeout(resolve, waitMs));
				delay *= factor;
			}
		}
	}
}
