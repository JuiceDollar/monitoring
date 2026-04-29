import { Test, TestingModule } from '@nestjs/testing';
import { ChallengeService } from './challenge.service';
import { AppConfigService } from '../config/config.service';
import { ChallengeRepository } from './prisma/repositories/challenge.repository';
import { EventsRepository } from './prisma/repositories/events.repository';
import { ProviderService } from './provider.service';
import { TelegramService } from './telegram.service';

describe('ChallengeService.checkAuctionDeadlines', () => {
	let service: ChallengeService;
	let challengeRepo: jest.Mocked<ChallengeRepository>;
	let telegram: jest.Mocked<TelegramService>;

	const NOW = 1_800_000_000n;
	const HOUR = 3600n;
	const CHALLENGE_PERIOD = 10n * 86_400n; // 10 days

	function makeChallenge(overrides: Partial<any> = {}) {
		return {
			challengeId: 1,
			hubAddress: '0xhub',
			challengerAddress: '0xchallenger',
			positionAddress: '0xposition',
			startTimestamp: NOW - 2n * CHALLENGE_PERIOD - 5n * 86_400n, // safely past auction end by default
			size: 100n,
			currentPrice: 1000n,
			t24Alerted: false,
			t2Alerted: false,
			challengePeriod: CHALLENGE_PERIOD,
			...overrides,
		};
	}

	// Build a challenge whose remaining time is exactly `remainingHours`.
	function withRemaining(remainingHours: bigint, overrides: Partial<any> = {}) {
		const start = NOW - (2n * CHALLENGE_PERIOD - remainingHours * HOUR);
		return makeChallenge({ startTimestamp: start, ...overrides });
	}

	beforeEach(async () => {
		challengeRepo = {
			findActiveWithChallengePeriod: jest.fn(),
			markT24Alerted: jest.fn(),
			markT2Alerted: jest.fn(),
			createMany: jest.fn(),
			updateMany: jest.fn(),
			findAllChallengeKeys: jest.fn(),
		} as any;
		telegram = { sendCriticalAlert: jest.fn() } as any;

		const moduleRef: TestingModule = await Test.createTestingModule({
			providers: [
				ChallengeService,
				{ provide: ChallengeRepository, useValue: challengeRepo },
				{ provide: TelegramService, useValue: telegram },
				{ provide: AppConfigService, useValue: {} },
				{ provide: EventsRepository, useValue: {} },
				{ provide: ProviderService, useValue: {} },
			],
		}).compile();

		service = moduleRef.get(ChallengeService);
		jest.spyOn(Date, 'now').mockReturnValue(Number(NOW) * 1000);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('does not alert when remaining time is well above 24h', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([withRemaining(72n)]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).not.toHaveBeenCalled();
		expect(challengeRepo.markT24Alerted).not.toHaveBeenCalled();
		expect(challengeRepo.markT2Alerted).not.toHaveBeenCalled();
	});

	it('emits T-24h alert and sets t24 flag when remaining <= 24h and > 2h', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([withRemaining(12n)]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).toHaveBeenCalledTimes(1);
		expect(telegram.sendCriticalAlert.mock.calls[0][0]).toContain('T-24h');
		expect(challengeRepo.markT24Alerted).toHaveBeenCalledTimes(1);
		expect(challengeRepo.markT2Alerted).not.toHaveBeenCalled();
	});

	it('emits T-2h alert and sets both flags when remaining <= 2h', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([withRemaining(1n)]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).toHaveBeenCalledTimes(1);
		expect(telegram.sendCriticalAlert.mock.calls[0][0]).toContain('T-2h');
		expect(challengeRepo.markT2Alerted).toHaveBeenCalledTimes(1);
		expect(challengeRepo.markT24Alerted).toHaveBeenCalledTimes(1);
	});

	it('does not re-alert T-24h when flag is already set', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([withRemaining(12n, { t24Alerted: true })]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).not.toHaveBeenCalled();
		expect(challengeRepo.markT24Alerted).not.toHaveBeenCalled();
	});

	it('does not re-alert T-2h when flag is already set', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([withRemaining(1n, { t2Alerted: true, t24Alerted: true })]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).not.toHaveBeenCalled();
		expect(challengeRepo.markT2Alerted).not.toHaveBeenCalled();
	});

	it('skips challenges already past auction end', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([makeChallenge()]); // default = past end
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).not.toHaveBeenCalled();
	});

	it('returns early when no active challenges exist', async () => {
		challengeRepo.findActiveWithChallengePeriod.mockResolvedValue([]);
		await service.checkAuctionDeadlines();
		expect(telegram.sendCriticalAlert).not.toHaveBeenCalled();
	});
});
