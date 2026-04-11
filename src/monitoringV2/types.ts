export interface Event {
	txHash: string;
	blockNumber: bigint;
	logIndex: number;
	contractAddress: string;
	topic: string;
	args: Record<string, any>;
	timestamp: bigint; // Unix timestamp in seconds
}

export enum ContractType {
	JUSD = 'JUSD',
	EQUITY = 'EQUITY',
	SAVINGS = 'SAVINGS',
	POSITION = 'POSITION',
	MINTER = 'MINTER',
	BRIDGE = 'BRIDGE',
	FRONTEND_GATEWAY = 'FRONTEND_GATEWAY',
	MINTING_HUB = 'MINTING_HUB',
	ROLLER = 'ROLLER',
	COLLATERAL = 'COLLATERAL',
}

// Integrate later (for API purposes)
export enum ChallengePhase {
	AVERTING = 'AVERTING',
	AUCTION = 'AUCTION',
	ENDED = 'ENDED',
}

export enum MinterStatus {
	PROPOSED = 'PROPOSED',
	DENIED = 'DENIED',
	APPROVED = 'APPROVED',
	EXPIRED = 'EXPIRED',
}

export interface Contract {
	address: string;
	type: ContractType;
	metadata?: Record<string, any>;
	timestamp: bigint; // Unix timestamp in seconds
}

export interface Token {
	address: string;
	symbol?: string;
	name?: string;
	decimals?: number;
	addedAt?: Date; // set by database
}

export interface PositionOpenedEvent {
	address: string;
	owner: string;
	original: string;
	collateral: string;
	timestamp: bigint; // Unix timestamp in seconds from blockchain event
}

export interface ChallengeStartedEvent {
	challengeId: number;
	challenger: string;
	position: string;
	size: bigint;
	timestamp: bigint; // Unix timestamp in seconds from blockchain event
	hubAddress: string; // MintingHub contract that emitted the event
}

export interface PositionState {
	// Fixed fields
	address: string;
	limit: bigint;
	owner: string;
	original: string;
	collateral: string;
	minimumCollateral: bigint;
	riskPremiumPpm: number;
	reserveContribution: number;
	challengePeriod: bigint;
	startTimestamp: bigint;
	expiration: bigint;
	created: bigint; // Unix timestamp when position was opened on blockchain

	// Dynamic fields
	price: bigint;
	virtualPrice: bigint;
	collateralAmount: bigint;
	expiredPurchasePrice: bigint;
	collateralRequirement: bigint;
	principal: bigint;
	interest: bigint;
	debt: bigint;
	fixedAnnualRatePpm: number;
	lastAccrual: bigint;
	cooldown: bigint;
	challengedAmount: bigint;
	availableForMinting: bigint;
	availableForClones: bigint;
	isClosed: boolean;
	isDenied: boolean;

	// Metadata
	timestamp: Date;
}

export interface ChallengeState {
	// Fixed fields
	challengeId: number;
	hubAddress: string; // MintingHub contract that owns this challenge
	challengerAddress: string;
	positionAddress: string;
	startTimestamp: bigint;
	initialSize: bigint;

	// Dynamic fields
	size: bigint;
	currentPrice: bigint;

	// Metadata
	timestamp: Date;
}

export interface CollateralState {
	// Fixed fields
	collateral: string;

	// Dynamic fields
	totalCollateral: bigint;
	positionCount: number;
	totalLimit: bigint;
	totalAvailableForMinting: bigint;

	// Metadata
	timestamp: Date;
}

export interface MinterState {
	// Fixed fields
	address: string;
	type: ContractType;
	applicationTimestamp: bigint;
	applicationPeriod: bigint;
	applicationFee: bigint;
	message: string;

	// Bridge-specific fields
	bridgeToken?: string;
	bridgeHorizon?: bigint;
	bridgeLimit?: bigint;

	// Dynamic fields
	status: MinterStatus;
	bridgeMinted?: bigint;

	// Metadata
	timestamp: Date;
}

export interface JusdState {
	// Token supplies
	jusdTotalSupply: bigint;
	juiceTotalSupply: bigint;

	// Equity metrics
	equityShares: bigint;
	equityPrice: bigint;

	// Reserve metrics
	reserveTotal: bigint;
	reserveMinter: bigint;
	reserveEquity: bigint;

	// Savings metrics
	savingsTotal: bigint;
	savingsInterestCollected: bigint;
	savingsRate: number;

	// Profit/Loss tracking
	jusdLoss: bigint;
	jusdProfit: bigint;
	jusdProfitDistributed: bigint;

	// Frontend metrics
	frontendFeesCollected: bigint;
	frontendsActive: number;

	// 24h metrics
	savingsInterestCollected24h: bigint;
	savingsAdded24h: bigint;
	savingsWithdrawn24h: bigint;
	equityTradeVolume24h: bigint;
	equityTradeCount24h: number;
	equityDelegations24h: number;

	// Metadata
	blockNumber: bigint;
	timestamp: Date;
}
