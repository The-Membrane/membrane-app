/*
 * Mock service functions for the Q-Racing visualiser.
 * They are async to mimic future network calls.
 * Replace the bodies with real API requests when backend endpoints are ready.
 */

import contracts from '@/config/contracts.json';
import { getCosmWasmClient } from '@/helpers/cosmwasmClient';
import { rpcUrl as defaultRpcUrl } from '@/config/defaults';

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
}

interface JsonPosition { car_id: string; x: number; y: number }
interface JsonAction { action: string; resulting_position: JsonPosition }
interface JsonPlayByPlay { starting_position: JsonPosition; actions: JsonAction[] }
interface JsonRank { car_id: string; rank: number }
interface JsonStep { car_id: string; steps_taken: number }
interface JsonRaceResult {
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

function raceResultToPlayByPlayEntries(result: JsonRaceResult): PlayByPlayEntry[] {
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

export async function getQRacingTrack(trackId = 'sample', rpcUrl: string = defaultRpcUrl): Promise<Track> {
    // Fallback to mock if track id is clearly a placeholder or contracts not configured
    const trackManagerAddr = (contracts as any).trackManager as string | undefined;
    const isNumericId = /^\d+$/.test(trackId);
    if (!trackManagerAddr || !isNumericId) {
        return mockTrack;
    }

    const client = await getCosmWasmClient(rpcUrl);
    // Rust expects { get_track: { track_id: Uint128-string } }
    const response = (await client.queryContractSmart(trackManagerAddr, {
        get_track: { track_id: trackId },
    })) as JsonTrack;

    return jsonTrackToLegendGrid(response);
}

export async function getQRacingLog(raceId = 'sample', rpcUrl: string = defaultRpcUrl): Promise<PlayByPlayEntry[]> {
    const raceEngineAddr = (contracts as any).raceEngine as string | undefined;
    const looksLikeId = raceId && raceId !== 'sample';
    if (!raceEngineAddr || !looksLikeId) {
        await artificialDelay();
        return mockLog;
    }

    const client = await getCosmWasmClient(rpcUrl);

    // list_recent_races -> RecentRacesResponse
    const recent = (await client.queryContractSmart(raceEngineAddr, {
        list_recent_races: { limit: 100 },
    })) as JsonRecentRacesResponse;

    const found = recent.races.find((r) => r.race_id === raceId);
    if (!found) {
        // As a fallback, return mock
        return mockLog;
    }

    return raceResultToPlayByPlayEntries(found);
}

// Helper – simulates network latency
async function artificialDelay(ms = 300): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
} 