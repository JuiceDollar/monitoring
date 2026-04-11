import {
	ERC20ABI,
	PositionV2ABI,
	SavingsGatewayABI,
	FrontendGatewayABI,
	MintingHubGatewayABI,
	MintingHubV2ABI,
	JuiceDollarABI,
	EquityABI,
	StablecoinBridgeABI,
	PositionRollerABI,
} from '@juicedollar/jusd';
import { ContractType } from './types';

export const EVENT_SIGNATURES: Record<string, string> = {
	// Position events (MintingHubGateway.sol)
	PositionOpened: 'PositionOpened(address,address,address,address)',
	ChallengeStarted: 'ChallengeStarted(address,address,uint256,uint256)',
	ChallengeSucceeded: 'ChallengeSucceeded(address,uint256,uint256,uint256,uint256)',
	ChallengeAverted: 'ChallengeAverted(address,uint256,uint256)',

	// Minter events (JuiceDollar.sol)
	MinterApplied: 'MinterApplied(address,uint256,uint256,string)',
	MinterDenied: 'MinterDenied(address,string)',

	// Trading events (Equity.sol)
	Trade: 'Trade(address,int256,uint256,uint256)',
	Delegation: 'Delegation(address,address)',

	// Roll event (PositionRoller.sol)
	Roll: 'Roll(address,uint256,uint256,address,uint256,uint256)',

	// Rate events (SavingsGateway.sol)
	RateChanged: 'RateChanged(uint24)',
	RateProposed: 'RateProposed(address,uint24,uint40)',

	// Rate changes events (FrontendGateway.sol)
	RateChangesProposed: 'RateChangesProposed(address,uint24,uint24,uint24,uint256)',
	RateChangesExecuted: 'RateChangesExecuted(address,uint24,uint24,uint24)',

	// Profit/Loss events (JuiceDollar.sol)
	Profit: 'Profit(address,uint256)',
	Loss: 'Loss(address,uint256)',
	ProfitDistributed: 'ProfitDistributed(address,uint256)',

	// Savings events (SavingsGateway.sol)
	Saved: 'Saved(address,uint192)',
	InterestCollected: 'InterestCollected(address,uint256)',
	InterestClaimed: 'InterestClaimed(address,uint192)',
	Withdrawn: 'Withdrawn(address,uint192)',

	// Frontend Gateway events (FrontendGateway.sol)
	FrontendCodeRegistered: 'FrontendCodeRegistered(address,bytes32)',
	FrontendCodeTransferred: 'FrontendCodeTransferred(address,address,bytes32)',
	FrontendCodeRewardsWithdrawn: 'FrontendCodeRewardsWithdrawn(address,uint256,bytes32)',
	NewPositionRegistered: 'NewPositionRegistered(address,bytes32)',

	// Reward events (FrontendGateway.sol)
	InvestRewardAdded: 'InvestRewardAdded(bytes32,address,uint256,uint256)',
	RedeemRewardAdded: 'RedeemRewardAdded(bytes32,address,uint256,uint256)',
	UnwrapAndSellRewardAdded: 'UnwrapAndSellRewardAdded(bytes32,address,uint256,uint256)',
	SavingsRewardAdded: 'SavingsRewardAdded(bytes32,address,uint256,uint256)',
	PositionRewardAdded: 'PositionRewardAdded(bytes32,address,uint256,uint256)',

	// MintingHub events (MintingHubGateway.sol)
	PostponedReturn: 'PostponedReturn(address,address,uint256)',
	ForcedSale: 'ForcedSale(address,uint256,uint256)',

	// Position events (Position.sol)
	MintingUpdate: 'MintingUpdate(uint256,uint256,uint256)',
	PositionDenied: 'PositionDenied(address,string)',
};

export const CONTRACT_ABI_MAP: Record<ContractType, any | undefined> = {
	[ContractType.JUSD]: JuiceDollarABI,
	[ContractType.EQUITY]: EquityABI,
	[ContractType.SAVINGS]: SavingsGatewayABI,
	[ContractType.FRONTEND_GATEWAY]: FrontendGatewayABI,
	[ContractType.MINTING_HUB]: MintingHubGatewayABI,
	[ContractType.POSITION]: PositionV2ABI,
	[ContractType.ROLLER]: PositionRollerABI,
	[ContractType.COLLATERAL]: ERC20ABI,
	[ContractType.BRIDGE]: StablecoinBridgeABI,
	[ContractType.MINTER]: undefined,
};
