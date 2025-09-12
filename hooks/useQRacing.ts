import { useQuery } from '@tanstack/react-query';
import { getQRacingTrack, JsonRaceResult, raceResultToPlayByPlayEntries, getRecentRacesForCar, getAllRecentRaces, getOwnedCars, Track, PlayByPlayEntry, useTopTimes, JsonTopTimeEntry, getRpsTickHistory, getRpsQ, getRpsHistory, getRpsConfig, JsonGetRpsTickHistoryResponse, JsonGetRpsQResponse, JsonGetRpsHistoryResponse, JsonGetRpsConfigResponse } from '../services/q-racing';
import useAppState from '@/persisted-state/useAppState';
import { useMemo } from 'react';
import contracts from '@/config/contracts.json';
import { getCosmWasmClient } from '@/helpers/cosmwasmClient';

// Query keys – keeping them stable helpers
const TRACK_KEY = ['q-racing', 'track'];
const LOG_KEY = ['q-racing', 'log'];
const RECENT_RACES_KEY = ['q-racing', 'recent-races'];
const OWNED_CARS_KEY = ['q-racing', 'owned_cars'];

export function useQRacingTrack(trackId?: string, rpcUrl?: string) {
    console.log('trackId', trackId);
    return useQuery<Track>({
        queryKey: [...TRACK_KEY, trackId ?? 'no-track', rpcUrl],
        queryFn: () => getQRacingTrack(trackId!, rpcUrl),
        enabled: !!trackId,
        staleTime: 30 * 60 * 1000, // 30 minutes
        refetchOnWindowFocus: false,
    });
}

// Convenience hook that fetches both pieces of data in parallel
export function useQRacing(trackId?: string, race?: JsonRaceResult, rpcUrl?: string) {
    const trackQuery = useQRacingTrack(trackId, rpcUrl);
    const log = useMemo(() => (race ? raceResultToPlayByPlayEntries(race) : undefined), [race?.race_id]);

    return {
        track: trackQuery.data,
        log,
        isLoading: trackQuery.isLoading,
        error: trackQuery.error,
        refetch: trackQuery.refetch,
    } as const;
}

// New hook to get recent races for a specific car
export function useRecentRacesForCar(carId: string | null) {
    const { appState } = useAppState();

    return useQuery<JsonRaceResult[]>({
        queryKey: [...RECENT_RACES_KEY, 'car', carId, appState.rpcUrl],
        queryFn: () => getRecentRacesForCar(carId!, appState.rpcUrl),
        enabled: !!carId,
        staleTime: 30 * 60 * 1000, // 30 minutes
    });
}

// New hook to get all recent races
export const useAllRecentRaces = () => {
    const { appState } = useAppState();

    return useQuery<JsonRaceResult[]>({
        queryKey: [...RECENT_RACES_KEY, 'all', appState.rpcUrl],
        queryFn: () => getAllRecentRaces(appState.rpcUrl),
        staleTime: 30 * 60 * 1000, // 30 minutes
    });
}

// New hook to get owned cars for a wallet address
export const useOwnedCars = (walletAddress: string | undefined) => {
    const { appState } = useAppState();

    return useQuery<Array<{ id: string; name: string | null }>>({
        queryKey: [...OWNED_CARS_KEY, walletAddress, appState.rpcUrl],
        queryFn: async () => {
            if (!walletAddress) return []
            return getOwnedCars(walletAddress, appState.rpcUrl)
        },
        staleTime: 30 * 60 * 1000, // 30 minutes
        // refetchOnMount: true,
        // refetchOnWindowFocus: true,
        // No refetchInterval - rely on manual invalidation for new mints
    });
}

export { useTopTimes };

// ---------------------------
// RPS Engine Hooks
// ---------------------------

export function useRpsTickHistory(carId?: string) {
    const { appState } = useAppState();
    return useQuery<JsonGetRpsTickHistoryResponse | null>({
        queryKey: ['rps_tick_history', (contracts as any).rpsEngine, carId, appState.rpcUrl],
        queryFn: async () => {
            if (!carId) return null;
            return getRpsTickHistory(carId, appState.rpcUrl);
        },
        enabled: Boolean(carId && (contracts as any).rpsEngine),
        staleTime: 1_800_000,
    });
}

export function useRpsQ(carId?: string, stateId?: number) {
    const { appState } = useAppState();
    return useQuery<JsonGetRpsQResponse | null>({
        queryKey: ['rps_q', (contracts as any).rpsEngine, carId, stateId, appState.rpcUrl],
        queryFn: async () => {
            if (!carId) return null;
            return getRpsQ(carId, stateId, appState.rpcUrl);
        },
        enabled: Boolean(carId && (contracts as any).rpsEngine),
        staleTime: 1_800_000,
    });
}

export function useRpsHistory(carId?: string) {
    const { appState } = useAppState();
    return useQuery<JsonGetRpsHistoryResponse | null>({
        queryKey: ['rps_history', (contracts as any).rpsEngine, carId, appState.rpcUrl],
        queryFn: async () => {
            if (!carId) return null;
            return getRpsHistory(carId, appState.rpcUrl);
        },
        enabled: Boolean(carId && (contracts as any).rpsEngine),
        staleTime: 1_800_000,
    });
}

export function useRpsConfig() {
    const { appState } = useAppState();
    return useQuery<JsonGetRpsConfigResponse | null>({
        queryKey: ['rps_config', (contracts as any).rpsEngine, appState.rpcUrl],
        queryFn: async () => getRpsConfig(appState.rpcUrl),
        enabled: Boolean((contracts as any).rpsEngine),
        staleTime: 1_800_000,
    });
}

// Byte-minter config hook
export function useByteMinterConfig(rpc?: string) {
    const { appState } = useAppState();
    const rpcUrl = rpc || appState.rpcUrl;

    return useQuery<{ mintAmount: string | null; difficulty: number | null }>({
        queryKey: ['byte_minter_config', (contracts as any).byteMinter, rpcUrl],
        queryFn: async () => {
            try {
                const addr = (contracts as any).byteMinter as string | undefined;
                if (!addr) return { mintAmount: null, difficulty: null };

                const client = await getCosmWasmClient(rpcUrl);
                const res = await client.queryContractSmart(addr, { get_config: {} } as any);

                // Expect shape { config: { mint_amount, maze_default_difficulty, tokenfactory_denom, ... } }
                const cfg = (res && (res as any).config) || res;
                if (!cfg) return { mintAmount: null, difficulty: null };

                const mintAmount = cfg.mint_amount?.toString?.() ?? String(cfg.mint_amount ?? '');
                const difficulty = typeof cfg.maze_default_difficulty === 'number'
                    ? cfg.maze_default_difficulty
                    : Number(cfg.maze_default_difficulty);

                return {
                    mintAmount: mintAmount || null,
                    difficulty: isNaN(difficulty) ? null : difficulty
                };
            } catch (e) {
                console.error('Error fetching byte-minter config', e);
                return { mintAmount: null, difficulty: null };
            }
        },
        enabled: Boolean((contracts as any).byteMinter),
        staleTime: 30 * 60 * 1000, // 30 minutes
        refetchInterval: 30 * 60 * 1000, // 30 minutes
    });
}
