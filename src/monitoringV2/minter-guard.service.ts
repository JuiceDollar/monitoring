import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { JuiceDollarABI, ADDRESS } from '@juicedollar/jusd';
import { AppConfigService } from '../config/config.service';
import { ProviderService } from './provider.service';
import { MinterRepository } from './prisma/repositories/minter.repository';
import { TelegramService } from './telegram.service';
import { MinterStatus } from './types';

interface Whitelist {
	minters: string[];
}

/**
 * Watches for newly proposed minters and automatically denies any that are not
 * in the configured whitelist. The deny window is the application period
 * specified in the suggestMinter call (typically days), so an hourly cadence is
 * sufficient. A bricked or wrong-network signer is a startup error and exits.
 */
@Injectable()
export class MinterGuardService {
	private readonly logger = new Logger(MinterGuardService.name);

	private enabled = false;
	private wallet?: ethers.Wallet;
	private juiceDollar?: ethers.Contract;
	private whitelist = new Set<string>();
	private helperAddress?: string;
	private alreadyDenied = new Set<string>();

	constructor(
		private readonly config: AppConfigService,
		private readonly providerService: ProviderService,
		private readonly minterRepo: MinterRepository,
		private readonly telegramService: TelegramService
	) {}

	async initialize(): Promise<void> {
		if (!this.config.guardEnabled) {
			this.logger.log('MinterGuard is DISABLED (GUARD_ENABLED != true)');
			return;
		}

		const pk = this.config.guardPrivateKey;
		const helper = this.config.guardHelperAddress;
		const whitelistFile = this.config.guardWhitelistFile;

		if (!pk) throw new Error('GUARD_ENABLED=true but GUARD_PRIVATE_KEY is missing');
		if (!helper) throw new Error('GUARD_ENABLED=true but GUARD_HELPER_ADDRESS is missing');
		if (!whitelistFile) throw new Error('GUARD_ENABLED=true but GUARD_WHITELIST_FILE is missing');

		this.wallet = new ethers.Wallet(pk, this.providerService.provider);
		this.helperAddress = ethers.getAddress(helper);

		const jusdAddress = ADDRESS[this.config.blockchainId]?.juiceDollar;
		if (!jusdAddress) throw new Error(`No JUSD address configured for chain ${this.config.blockchainId}`);
		this.juiceDollar = new ethers.Contract(jusdAddress, JuiceDollarABI, this.wallet);

		this.loadWhitelist(whitelistFile);
		this.enabled = true;

		this.logger.log(
			`MinterGuard ENABLED: signer=${this.wallet.address}, helper=${this.helperAddress}, ` +
				`whitelist=${this.whitelist.size} entries, jusd=${jusdAddress}`
		);
	}

	private loadWhitelist(path: string): void {
		try {
			const raw = fs.readFileSync(path, 'utf8');
			const parsed = JSON.parse(raw) as Whitelist;
			if (!Array.isArray(parsed.minters)) throw new Error('whitelist.minters must be an array');
			this.whitelist = new Set(parsed.minters.map((a) => a.toLowerCase()));
			this.logger.log(`Loaded whitelist with ${this.whitelist.size} entries from ${path}`);
		} catch (error) {
			throw new Error(`Failed to load whitelist from ${path}: ${error.message}`);
		}
	}

	/**
	 * Called by MonitoringService after syncMinters(). Iterates PROPOSED minters
	 * and denies any not on the whitelist that haven't been denied yet.
	 */
	async checkAndDeny(): Promise<void> {
		if (!this.enabled || !this.juiceDollar || !this.wallet || !this.helperAddress) return;

		const minters = await this.minterRepo.findAll();
		// Denies BRIDGE-typed proposals too: bridge type is inferred from a single
		// `usd()` view call, which is trivial to mimic in a malicious contract.
		// Legitimate new bridges must be added to the whitelist before proposal.
		const candidates = minters.filter(
			(m) =>
				m.status === MinterStatus.PROPOSED &&
				!this.whitelist.has(m.address.toLowerCase()) &&
				!this.alreadyDenied.has(m.address.toLowerCase())
		);

		if (candidates.length === 0) return;

		this.logger.warn(`Found ${candidates.length} unwhitelisted PROPOSED minter(s) to deny`);

		for (const minter of candidates) {
			const address = ethers.getAddress(minter.address);
			try {
				const message = `Auto-deny by minter-guard: not in whitelist (${this.config.environment ?? 'unknown'}/${this.config.chain ?? 'unknown'})`;
				const tx = await this.juiceDollar.denyMinter(address, [this.helperAddress], message);
				this.logger.warn(`Submitted denyMinter for ${address}: tx=${tx.hash}`);
				const receipt = await tx.wait();
				this.alreadyDenied.add(address.toLowerCase());
				this.logger.warn(`denyMinter confirmed for ${address}: block=${receipt.blockNumber}`);
				await this.telegramService.sendCriticalAlert(
					`🛡️ *Minter auto-denied*\n\n` +
						`Address: \`${address}\`\n` +
						`Tx: \`${tx.hash}\`\n` +
						`Block: ${receipt.blockNumber}\n` +
						`Message: ${message}`
				);
			} catch (error) {
				const errorMsg = typeof error?.message === 'string' && error.message ? error.message : String(error);
				this.logger.error(`Failed to deny minter ${address}: ${errorMsg}`, error?.stack || error);
				await this.telegramService.sendCriticalAlert(
					`⚠️ *Minter auto-deny FAILED*\n\n` +
						`Address: \`${address}\`\n` +
						`Error: ${errorMsg}\n\n` +
						`Manual denyMinter() required before application period expires.`
				);
			}
		}
	}
}
