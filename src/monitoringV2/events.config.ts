export enum EventSeverity {
	HIGH = 'HIGH', // Critical events that need immediate attention
	MEDIUM = 'MEDIUM', // Important events worth monitoring
	LOW = 'LOW', // Routine events for tracking
}

export interface EventConfig {
	severity: EventSeverity;
	enabled: boolean;
}

export const EVENT_CONFIG: Record<string, EventConfig> = {
	// Position events
	PositionOpened: { severity: EventSeverity.HIGH, enabled: true },
	MintingUpdate: { severity: EventSeverity.HIGH, enabled: true },
	PositionDenied: { severity: EventSeverity.MEDIUM, enabled: true },

	// Challenge events
	ChallengeStarted: { severity: EventSeverity.HIGH, enabled: true },
	ChallengeSucceeded: { severity: EventSeverity.HIGH, enabled: true },
	ChallengeAverted: { severity: EventSeverity.HIGH, enabled: true },

	// Minter events
	MinterApplied: { severity: EventSeverity.HIGH, enabled: true },
	MinterDenied: { severity: EventSeverity.LOW, enabled: false },

	// Trading events
	Trade: { severity: EventSeverity.LOW, enabled: false },
	Delegation: { severity: EventSeverity.LOW, enabled: false },

	// Roll event
	Roll: { severity: EventSeverity.LOW, enabled: false },

	// Rate events
	RateChanged: { severity: EventSeverity.MEDIUM, enabled: true },
	RateProposed: { severity: EventSeverity.HIGH, enabled: true },
	RateChangesProposed: { severity: EventSeverity.HIGH, enabled: true },
	RateChangesExecuted: { severity: EventSeverity.MEDIUM, enabled: true },

	// Profit/Loss events
	Profit: { severity: EventSeverity.LOW, enabled: false },
	Loss: { severity: EventSeverity.HIGH, enabled: true },
	ProfitDistributed: { severity: EventSeverity.LOW, enabled: false },

	// Savings events
	Saved: { severity: EventSeverity.LOW, enabled: false },
	InterestCollected: { severity: EventSeverity.LOW, enabled: false },
	InterestClaimed: { severity: EventSeverity.LOW, enabled: false },
	Withdrawn: { severity: EventSeverity.LOW, enabled: false },

	// Frontend Gateway events
	FrontendCodeRegistered: { severity: EventSeverity.LOW, enabled: false },
	FrontendCodeTransferred: { severity: EventSeverity.LOW, enabled: false },
	FrontendCodeRewardsWithdrawn: { severity: EventSeverity.LOW, enabled: false },
	NewPositionRegistered: { severity: EventSeverity.LOW, enabled: false },

	// Reward events
	InvestRewardAdded: { severity: EventSeverity.LOW, enabled: false },
	RedeemRewardAdded: { severity: EventSeverity.LOW, enabled: false },
	UnwrapAndSellRewardAdded: { severity: EventSeverity.LOW, enabled: false },
	SavingsRewardAdded: { severity: EventSeverity.LOW, enabled: false },
	PositionRewardAdded: { severity: EventSeverity.LOW, enabled: false },

	// MintingHub events
	PostponedReturn: { severity: EventSeverity.LOW, enabled: false },
	ForcedSale: { severity: EventSeverity.MEDIUM, enabled: true },
};

// Helper to get enabled events
export function getEnabledEvents(): Set<string> {
	return new Set(
		Object.entries(EVENT_CONFIG)
			.filter(([_, config]) => config.enabled)
			.map(([event, _]) => event)
	);
}
