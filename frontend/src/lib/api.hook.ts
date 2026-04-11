import { useEffect, useMemo, useState } from 'react';
import type { ChallengeResponse, CollateralResponse, JusdState, HealthResponse, MinterResponse, PositionResponse } from '../../../shared/types';

export interface DataState<T> {
	data?: T;
	error?: string;
}

export interface UseApiResult {
	health?: DataState<HealthResponse>;
	jusd?: DataState<JusdState>;
	positions?: DataState<PositionResponse[]>;
	collateral?: DataState<CollateralResponse[]>;
	challenges?: DataState<ChallengeResponse[]>;
	minters?: DataState<MinterResponse[]>;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const REFRESH_INTERVAL = 60000; // 1 minute

export function useApi(): UseApiResult {
	const [health, setHealth] = useState<DataState<HealthResponse>>();
	const [jusd, setJusd] = useState<DataState<JusdState>>();
	const [positions, setPositions] = useState<DataState<PositionResponse[]>>();
	const [collateral, setCollateral] = useState<DataState<CollateralResponse[]>>();
	const [challenges, setChallenges] = useState<DataState<ChallengeResponse[]>>();
	const [minters, setMinters] = useState<DataState<MinterResponse[]>>();

	useEffect(() => {
		fetchAllData();
		const interval = setInterval(fetchAllData, REFRESH_INTERVAL);
		return () => clearInterval(interval);
	}, []);

	async function fetchAllData(): Promise<void> {
		const healthResult = await fetchData('health', setHealth);
		if (!healthResult) return;

		await Promise.all([
			fetchData('jusd', setJusd),
			fetchData('positions', setPositions),
			fetchData('collateral', setCollateral),
			fetchData('challenges', setChallenges),
			fetchData('minters', setMinters),
		]);
	}

	async function fetchData<T>(endpoint: string, setState: (state: DataState<T>) => void) {
		try {
			const data: T = await fetchApi(`/${endpoint}`);
			setState({ data });
			return true;
		} catch (error: any) {
			setState({ error: error?.message || 'Unknown error' });
			return false;
		}
	}

	async function fetchApi<T>(endpoint: string): Promise<T> {
		const response = await fetch(`${API_BASE_URL}${endpoint}`);
		if (!response?.ok) throw new Error(`API Error: ${response.statusText}`);
		return await response.json();
	}

	return useMemo(
		() => ({
			health,
			jusd,
			positions,
			collateral,
			challenges,
			minters,
		}),
		[health, jusd, positions, collateral, challenges, minters]
	);
}
