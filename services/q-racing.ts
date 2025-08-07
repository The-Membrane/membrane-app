/*
 * Mock service functions for the Q-Racing visualiser.
 * They are async to mimic future network calls.
 * Replace the bodies with real API requests when backend endpoints are ready.
 */

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
const size = 10;
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

export async function getQRacingTrack(trackId = 'sample'): Promise<Track> {
    // TODO: replace with `fetch(`/api/q-racing/track/${trackId}`)` when ready
    await artificialDelay();
    return mockTrack;
}

export async function getQRacingLog(raceId = 'sample'): Promise<PlayByPlayEntry[]> {
    // TODO: replace with real API call
    await artificialDelay();
    return mockLog;
}

// Helper – simulates network latency
async function artificialDelay(ms = 300): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
} 