/*
 * Mock service functions for the Q-Racing visualiser.
 * They are async to mimic future network calls.
 * Replace the bodies with real API requests when backend endpoints are ready.
 */

import contracts from '@/config/contracts.json';
import { getCosmWasmClient } from '@/helpers/cosmwasmClient';
import { rpcUrl as defaultRpcUrl, rpcUrl } from '@/config/defaults';
import { useQuery } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Type declarations (kept local to avoid cross-file imports until the service
// is wired into the main type system).

export type TrackTile = 'W' | 'E' | 'F' | 'S' | 'K' | 'B';
export type Track = TrackTile[][];

export interface PlayByPlayEntry {
    tick: number;
    positions: Record<string, [number, number]>; // carId -> [x,y]
}
// --- Sample mock data ------------------------------------------------------

// Single-tile legend: W = wall, E = empty, F = finish, S = start, K = stuck, B = boost
const size = 70;
const mockTrack: Track = generateMockTrack(size);

function generateMockTrack(n: number): Track {
    const rows: Track = [];
    for (let y = 0; y < n; y++) {
        const row: TrackTile[] = [];
        for (let x = 0; x < n; x++) {
            // Border walls
            if (x === 0 || y === 0 || x === n - 1 || y === n - 1) {
                row.push('W');
            } else {
                row.push('K');
            }
        }
        rows.push(row);
    }
    // place start and finish
    rows[1][1] = 'S';
    rows[n - 2][n - 2] = 'F';
    return rows;
}

const mockLog: PlayByPlayEntry[] = [
    { tick: 0, positions: { '1': [1, 1], '2': [1, 1] } },
    { tick: 1, positions: { '1': [2, 1], '2': [1, 2] } },
    { tick: 2, positions: { '1': [2, 2], '2': [2, 2] } },
    { tick: 3, positions: { '1': [2, 3], '2': [3, 2] } },
    { tick: 4, positions: { '1': [3, 3], '2': [3, 3] } },
];

// ---------------------------------------------------------------------------
// Real query helpers and converters

// Rust JSON mirrors (partial) ------------------------------------------------
// These mirror the on-chain JSON for the minimal fields we need to convert.
interface JsonTileProperties {
    speed_modifier: number;
    blocks_movement: boolean;
    skip_next_turn: boolean;
    damage: number;
    is_finish: boolean;
    is_start: boolean;
}
interface JsonTrackTile {
    properties: JsonTileProperties;
    x: number;
    y: number;
    progress_towards_finish: number;
}
interface JsonTrack {
    creator: string;
    id: string; // Uint128 -> string
    name: string;
    width: number;
    height: number;
    layout: JsonTrackTile[][];
    fastest_tick_time: string; // u64 -> string
    starting_tiles: JsonTrackTile[];
}
interface JsonListTracksResponse { tracks: JsonTrack[] }
interface JsonPosition { car_id: string; x: number; y: number }
interface JsonAction { action: string; resulting_position: JsonPosition }
interface JsonPlayByPlay { starting_position: JsonPosition; actions: JsonAction[] }
interface JsonRank { car_id: string; rank: number }
interface JsonStep { car_id: string; steps_taken: number }
export interface JsonRaceResult {
    race_id: string;
    track_id: string; // Uint128 -> string
    car_ids: string[];
    winner_ids: string[];
    rankings: JsonRank[];
    play_by_play: Record<string, JsonPlayByPlay>; // car_id -> events
    steps_taken: JsonStep[];
}
interface JsonRaceResultResponse { result: JsonRaceResult }
interface JsonRecentRacesResponse { races: JsonRaceResult[] }

// Add new interfaces for car queries
interface JsonTokensResponse {
    tokens: string[]
}

interface JsonAllTokensResponse {
    tokens: JsonTokensResponse;
}

// New: Training stats JSON mirrors (from Rust structs in race_engine.rs/types.rs)
export interface JsonTrainingStats {
    tally: number; // u32
    win_rate: number; // u32 (percentage)
    fastest: number; // u32 (ticks)
    first_time: number; // u32 (ticks)
}

export interface JsonTrackTrainingStats {
    solo: JsonTrainingStats;
    pvp: JsonTrainingStats;
}

export interface JsonGetTrackTrainingStatsResponse {
    car_id: string; // u128 -> string
    track_id: string; // u128 -> string
    stats: JsonTrackTrainingStats;
}

// Q-table types and queries ---------------------------------------------------
export interface JsonQTableEntry {
    state_hash: string | number[]; // serialized bytes; treat as opaque id
    action_values: [number, number, number, number];
}

export interface JsonGetQResponse {
    car_id: string;
    q_values: JsonQTableEntry[];
}

export async function getCarQTable(carId: string, rpc: string = defaultRpcUrl): Promise<JsonGetQResponse | null> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return null;
    }
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(raceEngineAddr, {
            get_integer_q: { car_id: carId },
        })) as JsonGetQResponse;
        return response ?? null;
    } catch (error) {
        console.error('Error fetching car Q-table:', error);
        return null;
    }
}

export function useCarQTable(carId?: string, rpc: string = defaultRpcUrl) {
    return useQuery<JsonGetQResponse | null>({
        queryKey: ['car_q_table', (contracts as any).raceEngine, carId, rpc],
        queryFn: async () => {
            if (!carId) return null;
            return getCarQTable(carId, rpc);
        },
        enabled: Boolean(carId && (contracts as any).raceEngine),
        staleTime: 1_800_000, // 30 minutes
    });
}

// Car metadata (traits) via CW721 nft_info ------------------------------------
export interface JsonNFTAttribute { trait_type: string; value: string }
export interface JsonNFTMetadata { attributes?: JsonNFTAttribute[]; name?: string | null }
export interface JsonNftInfoResponse { token_uri?: string; extension?: JsonNFTMetadata }

export async function getCarMetadata(tokenId: string, rpc: string = defaultRpcUrl): Promise<JsonNFTAttribute[] | null> {
    const carAddr = (contracts as any).car as string | undefined;
    if (!carAddr) {
        await artificialDelay();
        return null;
    }
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(carAddr, {
            nft_info: { token_id: tokenId },
        })) as JsonNftInfoResponse;
        // console.log('nft info res', response);
        return response?.extension?.attributes ?? null;
    } catch (error) {
        console.error('Error fetching car metadata:', error);
        return null;
    }
}

export function useCarMetadata(tokenId?: string, rpc: string = defaultRpcUrl) {
    return useQuery<JsonNFTAttribute[] | null>({
        queryKey: ['car_metadata', (contracts as any).car, tokenId, rpc],
        queryFn: async () => {
            if (!tokenId) return null;
            return getCarMetadata(tokenId, rpc);
        },
        enabled: Boolean(tokenId && (contracts as any).car),
        staleTime: 1_800_000, // 30 minutes
    });
}

// New: Fetch car name via CW721 base.nft_info
export async function getCarName(tokenId: string, rpc: string = defaultRpcUrl): Promise<string | null> {
    const carAddr = (contracts as any).car as string | undefined;
    if (!carAddr) {
        await artificialDelay();
        return null;
    }
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(carAddr, {
            nft_info: { token_id: tokenId },
        })) as JsonNftInfoResponse;
        return response?.extension?.name ?? null;
    } catch (error) {
        console.error('Error fetching car name:', error);
        return null;
    }
}

export function useCarName(tokenId?: string, rpc: string = defaultRpcUrl) {
    return useQuery<string | null>({
        queryKey: ['car_name', (contracts as any).car, tokenId, rpc],
        queryFn: async () => {
            if (!tokenId) return null;
            return getCarName(tokenId, rpc);
        },
        enabled: Boolean(tokenId && (contracts as any).car),
        staleTime: 1_800_000, // 30 minutes
    });
}

// ---------------------------------------------------------------------------
// Energy: CarInfo with energy fields via custom query

export interface JsonCarInfoResponse {
    owners: string[];
    metadata?: JsonNFTMetadata | null;
    created_at: number;
    current_energy: number;
    last_energy_update_nanos: number;
    max_energy: number;
    energy_recovery_hours: number;
    energy_per_training: number;
    training_payment_options: { denom: string; amount: string }[];
}

export async function getCarEnergy(tokenId: string, rpc: string = defaultRpcUrl): Promise<JsonCarInfoResponse | null> {
    const carAddr = (contracts as any).car as string;
    const client = await getCosmWasmClient(rpc);
    console.log('getCarEnergy', tokenId, rpc)
    try {
        const response = (await client.queryContractSmart(carAddr, {
            get_car_info: { token_id: tokenId },
        })) as JsonCarInfoResponse;
        return response ?? null;
    } catch (error) {
        console.error('Error fetching car energy:', error);
        return null;
    }
}

export function useCarEnergy(tokenId?: string, rpc: string = defaultRpcUrl) {
    console.log('useCarEnergy', tokenId, rpc)
    return useQuery<JsonCarInfoResponse | null>({
        queryKey: ['car_energy', (contracts as any).car, tokenId, rpc],
        queryFn: async () => {
            if (!tokenId) return null;
            return getCarEnergy(tokenId, rpc);
        },
        enabled: Boolean(tokenId && (contracts as any).car),
        staleTime: 1_800_000, // 30 minutes
        // No refetchInterval - rely on manual invalidation
    });
}

// ---------------------------------------------------------------------------
// Byte-minter: seconds until next window (maze or pvp)

export type ByteMinterEvent = 'maze' | 'pvp'

export async function getSecondsUntilOpen(event: ByteMinterEvent, rpc: string = defaultRpcUrl): Promise<number | null> {
    const addr = (contracts as any).byteMinter as string | undefined
    if (!addr) return null
    const client = await getCosmWasmClient(rpc)
    try {
        const payload = { seconds_until_open: { event } } as any
        const res = (await client.queryContractSmart(addr, payload)) as number
        return typeof res === 'number' ? res : null
    } catch (e) {
        console.error('Error fetching byte-minter countdown', e)
        return null
    }
}

export function useSecondsUntilOpen(event: ByteMinterEvent, rpc: string = defaultRpcUrl) {
    return useQuery<number | null>({
        queryKey: ['byte_minter_until_open', (contracts as any).byteMinter, event, rpc],
        queryFn: async () => getSecondsUntilOpen(event, rpc),
        enabled: Boolean((contracts as any).byteMinter),
        staleTime: 1_800_000, // 30 minutes
        // No refetchInterval - rely on manual invalidation
    })
}

// Byte-minter: get valid maze ID
export async function getValidMazeId(rpc: string = defaultRpcUrl): Promise<string | null> {
    const addr = (contracts as any).byteMinter as string | undefined
    if (!addr) return null
    const client = await getCosmWasmClient(rpc)
    try {
        const res = (await client.queryContractSmart(addr, { valid_maze_i_d: {} } as any)) as any
        console.log('getValidMazeId res', res)
        return res?.toString() ?? null
    } catch (e) {
        console.error('Error fetching valid maze ID', e)
        return null
    }
}

export function useValidMazeId(rpc: string = defaultRpcUrl) {
    return useQuery<string | null>({
        queryKey: ['byte_minter_valid_maze_id', (contracts as any).byteMinter, rpc],
        queryFn: async () => getValidMazeId(rpc),
        enabled: Boolean((contracts as any).byteMinter),
        staleTime: 1_800_000, // 30 minutes
        // No refetchInterval - rely on manual invalidation
    })
}

// Byte-minter: get window status
export async function getWindowStatus(event: ByteMinterEvent, rpc: string = defaultRpcUrl): Promise<{ is_active: boolean; seconds_until_open: number; seconds_until_close: number } | null> {
    const addr = (contracts as any).byteMinter as string | undefined
    if (!addr) return null
    const client = await getCosmWasmClient(rpc)
    try {
        const payload = { get_window_status: { event } } as any
        const res = (await client.queryContractSmart(addr, payload)) as any
        return {
            is_active: res.is_active,
            seconds_until_open: res.seconds_until_open,
            seconds_until_close: res.seconds_until_close
        }
    } catch (e) {
        console.error('Error fetching window status', e)
        return null
    }
}

export function useWindowStatus(event: ByteMinterEvent, rpc: string = defaultRpcUrl) {
    return useQuery({
        queryKey: ['byte_minter_window_status', (contracts as any).byteMinter, event, rpc],
        queryFn: async () => getWindowStatus(event, rpc),
        enabled: Boolean((contracts as any).byteMinter),
        staleTime: 1_800_000, // 30 minutes
        // No refetchInterval - rely on manual invalidation
    })
}

export function formatCountdown(seconds?: number | null) {
    if (seconds == null) return '—'
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${pad(h)}:${pad(m)}:${pad(r)}`
}

function toLegendTile(tile: JsonTrackTile): TrackTile {
    const p = tile.properties;
    if (p.blocks_movement) return 'W';
    if (p.is_finish) return 'F';
    if (p.is_start) return 'S';
    if (p.skip_next_turn) return 'K';
    if (p.speed_modifier > 1) return 'B';
    return 'E';
}

function jsonTrackToLegendGrid(track: JsonTrack): Track {
    return track.layout.map((row) => row.map((t) => toLegendTile(t)));
}

export function raceResultToPlayByPlayEntries(result: JsonRaceResult): PlayByPlayEntry[] {
    // Build per-car sequences of positions from starting_position + actions
    const carIds = Object.keys(result.play_by_play);
    if (carIds.length === 0) return [];

    // Prepare per-car arrays of positions per tick
    const carPositions: Record<string, [number, number][]> = {};
    let maxTicks = 0;

    for (const carId of carIds) {
        const pbp = result.play_by_play[carId];
        const positions: [number, number][] = [];
        // tick 0 is the starting position
        positions.push([pbp.starting_position.x, pbp.starting_position.y]);
        for (const act of pbp.actions) {
            positions.push([act.resulting_position.x, act.resulting_position.y]);
        }
        carPositions[carId] = positions;
        if (positions.length > maxTicks) maxTicks = positions.length;
    }

    const timeline: PlayByPlayEntry[] = [];
    // For ticks beyond a car's last action, keep its last known position
    const lastKnown: Record<string, [number, number]> = {};
    for (let tick = 0; tick < maxTicks; tick++) {
        const positions: Record<string, [number, number]> = {};
        for (const carId of carIds) {
            const seq = carPositions[carId];
            const pos = seq[tick] ?? lastKnown[carId] ?? seq[seq.length - 1];
            positions[carId] = pos;
            lastKnown[carId] = pos;
        }
        timeline.push({ tick, positions });
    }
    return timeline;
}

// ---------------------------------------------------------------------------

export async function getQRacingTrack(trackId: string, rpcUrl: string = defaultRpcUrl): Promise<Track> {
    // Fallback to mock if track id is clearly a placeholder or contracts not configured
    const isNumericId = /^\d+$/.test(trackId);
    if (!isNumericId) {
        return mockTrack;
    }

    const client = await getCosmWasmClient(rpcUrl);
    console.log('HERE');
    // Rust expects { get_track: { track_id: Uint128-string } }
    const response = (await client.queryContractSmart(contracts.trackManager, {
        get_track: { track_id: trackId },
    })) as JsonTrack;
    console.log('response', response);

    return jsonTrackToLegendGrid(response);
}

// List tracks from track manager
export async function listTracks(rpc: string = defaultRpcUrl): Promise<JsonTrack[]> {
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(contracts.trackManager, {
            list_tracks: {
                limit: 200,
            },
        })) as JsonListTracksResponse;
        console.log('response tracks', response.tracks);
        return response.tracks ?? [];
    } catch (error) {
        console.error('Error listing tracks:', error);
        return [];
    }
}

export function useListTracks(rpc: string = defaultRpcUrl) {
    // console.log('useListTracks hook called with rpc:', rpc)
    return useQuery({
        queryKey: ['list_tracks', contracts.trackManager, rpc],
        queryFn: async () => {
            // console.log('useListTracks queryFn executing...')
            const result = await listTracks(rpc)
            // console.log('useListTracks queryFn completed with result:', result?.length)
            return result
        },
        refetchOnMount: true,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 1_800_000, // 30 minutes - can still be invalidated and refetched manually
    });
}


// New function to get recent races for a specific car
export async function getRecentRacesForCar(carId: string, rpcUrl: string = defaultRpcUrl): Promise<JsonRaceResult[]> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return [];
    }

    const client = await getCosmWasmClient(rpcUrl);

    try {
        console.log('getRecentRacesForCar: Fetching races for carId:', carId, 'with limit: 100');
        const response = (await client.queryContractSmart(raceEngineAddr, {
            list_recent_races: {
                car_id: carId,
                limit: 100
            },
        })) as JsonRecentRacesResponse;

        console.log('getRecentRacesForCar: Received', response.races?.length || 0, 'races');
        if (response.races && response.races.length > 0) {
            console.log('getRecentRacesForCar: First race ID:', response.races[0].race_id);
            console.log('getRecentRacesForCar: Last race ID:', response.races[response.races.length - 1].race_id);
        }

        return response.races;
    } catch (error) {
        console.error('Error fetching recent races for car:', error);
        return [];
    }
}

// New function to get all recent races
export async function getAllRecentRaces(rpcUrl: string = defaultRpcUrl, carId?: string, trackId?: string): Promise<JsonRaceResult[]> {
    const client = await getCosmWasmClient(rpcUrl);

    try {
        const response = (await client.queryContractSmart(contracts.raceEngine, {
            list_recent_races: {
                car_id: carId ? carId : undefined,
                track_id: trackId ? trackId : undefined,
                limit: 100
            },
        })) as JsonRecentRacesResponse;

        return response.races;
    } catch (error) {
        console.error('Error fetching all recent races:', error);
        return [];
    }
}

// New function to get owned cars for a wallet address
export async function getOwnedCars(walletAddress: string, rpcUrl: string = defaultRpcUrl): Promise<Array<{ id: string; name: string | null }>> {


    const client = await getCosmWasmClient(rpcUrl);

    try {
        // Query all tokens owned by the wallet address
        const response = (await client.queryContractSmart(contracts.car, {
            tokens: {
                owner: walletAddress,
                limit: 100
            }
        })) as JsonTokensResponse;

        const tokens = response.tokens ?? [];
        console.log('getOwnedCars tokens', walletAddress, rpcUrl, tokens?.length)
        const results = await Promise.all(
            tokens.map(async (token) => {
                try {
                    const info = (await client.queryContractSmart(contracts.car, {
                        nft_info: { token_id: token }
                    })) as JsonNftInfoResponse;
                    const name = info?.extension?.name ?? null;
                    return { id: token, name };
                } catch (e) {
                    return { id: token, name: null };
                }
            })
        );

        return results;
    } catch (error) {
        console.error('Error fetching owned cars:', error);
        return [];
    }
}

// ---------------------------------------------------------------------------
// New: GetTrackTrainingStats (car + track scoped)

export async function getTrackTrainingStats(
    carId: string,
    trackId: string,
    rpc: string = defaultRpcUrl,
): Promise<JsonGetTrackTrainingStatsResponse | null> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return null;
    }

    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(raceEngineAddr, {
            get_track_training_stats: {
                car_id: carId,
                track_id: trackId,
                limit: 1,
            },
        })) as JsonGetTrackTrainingStatsResponse[];

        return response?.[0] ?? null;
    } catch (error) {
        console.error('Error fetching track training stats:', error);
        return null;
    }
}

// New: Get all training stats for a car across all tracks
export async function getAllTrackTrainingStats(
    carId: string,
    rpc: string = defaultRpcUrl,
): Promise<JsonGetTrackTrainingStatsResponse[]> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return [];
    }

    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(raceEngineAddr, {
            get_track_training_stats: {
                car_id: carId,
                track_id: null, // null means all tracks
                limit: 100, // reasonable limit for all tracks
            },
        })) as JsonGetTrackTrainingStatsResponse[];

        return response ?? [];
    } catch (error) {
        console.error('Error fetching all track training stats:', error);
        return [];
    }
}

export function useTrackTrainingStats(
    carId?: string,
    trackId?: string,
    rpc: string = defaultRpcUrl,
) {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    return useQuery({
        queryKey: ['track_training_stats', raceEngineAddr, carId, trackId, rpc],
        queryFn: async () => {
            if (!carId || !trackId) return null;
            return getTrackTrainingStats(carId, trackId, rpc);
        },
        enabled: Boolean(raceEngineAddr && carId && trackId),
        staleTime: 1_800_000, // 30 minutes
        refetchOnMount: false, // Don't refetch on every mount
        refetchOnWindowFocus: false, // Don't refetch on every focus
    });
}

// ---------------------------------------------------------------------------
// Top times per track

export interface JsonTopTimeEntry { car_id: string; time: number }
export interface JsonTopTimes { entries: JsonTopTimeEntry[] }

export async function getTopTimes(trackId: string, rpc: string = defaultRpcUrl): Promise<JsonTopTimeEntry[]> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return [];
    }
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(raceEngineAddr, {
            get_top_times: { track_id: trackId },
        })) as JsonTopTimes;
        const entries = response?.entries ?? [];
        return entries.slice().sort((a, b) => a.time - b.time);
    } catch (error) {
        console.error('Error fetching top times:', error);
        return [];
    }
}

export function useTopTimes(trackId?: string, rpc: string = defaultRpcUrl) {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    return useQuery<JsonTopTimeEntry[]>({
        queryKey: ['top_times', raceEngineAddr, trackId, rpc],
        queryFn: async () => {
            if (!trackId) return [];
            return getTopTimes(trackId, rpc);
        },
        enabled: Boolean(raceEngineAddr && trackId),
        staleTime: 1_800_000, // 30 minutes
        refetchOnMount: false, // Don't refetch on every mount
        refetchOnWindowFocus: false, // Don't refetch on every focus
    });
}

// Extended top time entry with training session count
export interface JsonTopTimeEntryWithSessions extends JsonTopTimeEntry {
    sessions: number;
}

// Hook to get top times with training session counts
export function useTopTimesWithSessions(trackId?: string, rpc: string = defaultRpcUrl) {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;

    return useQuery<JsonTopTimeEntryWithSessions[]>({
        queryKey: ['top_times_with_sessions', raceEngineAddr, trackId, rpc],
        queryFn: async () => {
            if (!trackId) return [];

            // First get the top times
            const topTimes = await getTopTimes(trackId, rpc);

            // Then fetch training stats for each car
            const topTimesWithSessions: JsonTopTimeEntryWithSessions[] = await Promise.all(
                topTimes.map(async (entry) => {
                    try {
                        const trainingStats = await getTrackTrainingStats(entry.car_id, trackId, rpc);
                        const sessions = trainingStats?.stats?.solo?.tally ?? 0;
                        return {
                            ...entry,
                            sessions
                        };
                    } catch (error) {
                        console.error(`Error fetching training stats for car ${entry.car_id}:`, error);
                        return {
                            ...entry,
                            sessions: 0
                        };
                    }
                })
            );

            return topTimesWithSessions;
        },
        enabled: Boolean(raceEngineAddr && trackId),
        staleTime: 1_800_000, // 30 minutes
        refetchOnMount: false, // Don't refetch on every mount
        refetchOnWindowFocus: false, // Don't refetch on every focus
    });
}

// Brain Progress types and queries ---------------------------------------------------
export interface JsonBrainProgressEntry {
    timestamp: string; // Timestamp as string
    states_seen: number; // u16
    avg_confidence: number; // u8
    wall_collisions: number; // u16
}

export interface JsonBrainProgress {
    entries: JsonBrainProgressEntry[];
    total_states_seen: number; // u16
    current_avg_confidence: number; // u8
    total_wall_collisions: number; // u32
}

export interface JsonBrainProgressResponse {
    car_id: string;
    brain_progress: JsonBrainProgress;
}

export async function getCarBrainProgress(carId: string, rpc: string = defaultRpcUrl): Promise<JsonBrainProgressResponse | null> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    if (!raceEngineAddr) {
        await artificialDelay();
        return null;
    }
    const client = await getCosmWasmClient(rpc);
    try {
        const response = (await client.queryContractSmart(raceEngineAddr, {
            get_brain_progress: { car_id: carId },
        })) as JsonBrainProgressResponse;
        return response ?? null;
    } catch (error) {
        console.error('Error fetching car brain progress:', error);
        return null;
    }
}

export function useCarBrainProgress(carId?: string, rpc: string = defaultRpcUrl) {
    return useQuery<JsonBrainProgressResponse | null>({
        queryKey: ['car_brain_progress', (contracts as any).raceEngine, carId, rpc],
        queryFn: async () => {
            if (!carId) return null;
            return getCarBrainProgress(carId, rpc);
        },
        enabled: Boolean(carId && (contracts as any).raceEngine),
        staleTime: 1_800_000, // 30 minutes
    });
}

// Helper – simulates network latency
async function artificialDelay(ms = 300): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
} 