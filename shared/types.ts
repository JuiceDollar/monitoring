export enum PositionStatus {
	PROPOSED = 'PROPOSED',
	DENIED = 'DENIED',
	OPEN = 'OPEN',
	COOLDOWN = 'COOLDOWN',
	CHALLENGED = 'CHALLENGED',
	UNDERCOLLATERALIZED = 'UNDERCOLLATERALIZED',
	EXPIRED = 'EXPIRED',
	CLOSED = 'CLOSED',
}

export enum ChallengeStatus {
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

export enum MinterType {
	MINTER = 'MINTER',
	BRIDGE = 'BRIDGE',
}

export enum HealthState {
	OK = 'OK',
	OFFLINE = 'OFFLINE',
	FAILING = 'FAILING',
}

export interface HealthResponse {
	status: HealthState;
	consecutiveFailures: number;
	lastProcessedBlock: number;
	lastCompletedBlock: number;
	currentBlock?: number;
	blocksBehind?: number;
	updatedAt: string; // Unix timestamp in milliseconds as string
	rpcStats: Record<string, { calls: number; errors: number }>;
}

export interface PositionResponse {
	address: string;
	status: PositionStatus;
	owner: string;
	original: string;
	collateral: string;
	collateralSymbol: string;
	collateralBalance: string;
	minimumCollateral: string;
	price: string;
	virtualPrice: string;
	expiredPurchasePrice: string;
	collateralRequirement: string;
	debt: string;
	interest: string;
	principal: string;
	limitAmount: string;
	availableForMinting: string;
	availableForClones: string;
	challengedAmount: string;
	riskPremiumPpm: number;
	reserveContribution: number;
	fixedAnnualRatePpm: number;
	start: string; // Unix timestamp in milliseconds as string
	cooldown: string; // Unix timestamp in milliseconds as string
	expiration: string; // Unix timestamp in milliseconds as string
	challengePeriod: string; // Duration in seconds as string (NOT a timestamp)
	isClosed: boolean;
	created: string; // Unix timestamp in milliseconds as string
	marketPrice: string;
	collateralizationRatio: string;
}

export interface ChallengeResponse {
	id: number;
	hubAddress: string;
	challenger: string;
	position: string;
	start: string; // Unix timestamp in milliseconds as string
	initialSize: string;
	size: string;
	currentPrice: string;
	status: ChallengeStatus;
	liquidationPrice: string;
	collateral: string;
	collateralSymbol: string;
	collateralBalance: string;
	challengePeriod: string; // Duration in seconds as string (NOT a timestamp)
}

// Frontend-specific types that don't come from API
export interface JusdState {
	jusdTotalSupply: string;
	juiceTotalSupply: string;
	equityShares: string;
	equityPrice: string;
	reserveTotal: string;
	reserveMinter: string;
	reserveEquity: string;
	equityTradeVolume24h: string;
	equityTradeCount24h: number;
	equityDelegations24h: number;
	jusdLoss: string;
	jusdProfit: string;
	jusdProfitDistributed: string;
	savingsTotal: string;
	savingsRate: string;
	savingsAdded24h: string;
	savingsWithdrawn24h: string;
	savingsInterestCollected24h: string;
	savingsInterestCollected: string;
	frontendFeesCollected: string;
	frontendsActive: number;
}

export interface CollateralResponse {
	collateral: string;
	symbol: string;
	price: string;
	totalCollateral: string;
	totalLimit: string;
	totalAvailableForMinting: string;
	positionCount: number;
	updatedAt: string; // Unix timestamp in milliseconds as string
}

export interface MinterResponse {
	address: string;
	type: MinterType;
	status: MinterStatus;
	applicationTimestamp: string; // Unix timestamp in milliseconds as string
	applicationPeriod: string; // Duration in seconds as string (NOT a timestamp)
	applicationFee: string;
	message: string;

	bridgeToken?: string;
	bridgeTokenSymbol?: string;
	bridgeLimit?: string;
	bridgeMinted?: string;
	bridgeHorizon?: string; // Unix timestamp in milliseconds as string
}

// Minter-guard delegation status (GET /guard). All bigints are stringified. The private key never
// leaves the backend — only the derived signer address is exposed. This shape is the backend<->frontend
// contract and MUST stay byte-identical on both sides.
export interface GuardResponse {
	enabled: boolean;
	signerAddress: string;
	votingPowerPct: string; // percent, e.g. "1.85"
	quorumPct: number; // qualification threshold in percent (2)
	qualified: boolean;
	helperCount: number; // helpers contributed by the Delegation graph + the optional static seed
	gasBalance: string; // signer balance in native units (Citrea: cBTC, 18 decimals)
	estimatedDenyCost: string; // modelled denyMinter() cost in native units
	gasEnough: boolean;
	equityAddress: string;
	chainId: number;
}
