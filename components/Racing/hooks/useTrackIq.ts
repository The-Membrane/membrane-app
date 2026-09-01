import { useMemo } from 'react';

// Derives the "Track IQ" percentage for a car's Q-table on a given track:
// the share of reachable, non-wall-preferring states the car has learned.
export default function useTrackIq(track: any, qTableData: any): number {
    return useMemo(() => {
        if (!track || !qTableData) return 0;
        const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;
        const TileFlag = { Wall: 0, Sticky: 1, Boost: 2, Finish: 3, Normal: 4 } as const;
        const getFlag = (x: number, y: number): number => {
            if (y < 0 || x < 0 || y >= track.length || x >= track[0].length) return TileFlag.Wall;
            const t = track[y][x];
            if (t === 'W') return TileFlag.Wall; if (t === 'K') return TileFlag.Sticky; if (t === 'B') return TileFlag.Boost; if (t === 'F') return TileFlag.Finish; return TileFlag.Normal;
        };
        const states = new Set<number>();
        let finishes = 0; for (let y = 0; y < track.length; y++) { for (let x = 0; x < track[y].length; x++) { if (track[y][x] === 'F') finishes++; } }
        for (let y = 0; y < track.length; y++) {
            for (let x = 0; x < track[y].length; x++) {
                const tile = track[y][x];
                if (tile === 'W') continue;
                if (tile === 'F' && finishes <= 1) continue;
                let key = 0;
                for (let i = 0; i < DIRS.length; i++) {
                    const dx = (DIRS[i] as any)[0]; const dy = (DIRS[i] as any)[1];
                    const flag = getFlag(x + dx, y + dy);
                    key |= (flag << (i * 4));
                }
                states.add(key);
            }
        }
        const total = states.size || 1;
        const qMap = new Map<number, any>();
        qTableData.q_values.forEach((q: any) => {
            let sh: number;
            if (typeof q.state_hash === 'string') sh = parseInt(q.state_hash);
            else if (Array.isArray(q.state_hash)) sh = q.state_hash.reduce((a: number, b: number, i: number) => a + (b << (i * 8)), 0);
            else sh = q.state_hash;
            qMap.set(sh, q.action_values);
        });
        let seen = 0, wallPref = 0;
        states.forEach((h) => {
            const v = qMap.get(h);
            if (v) {
                seen++;
                const maxQ = Math.max(...v); const idx = v.indexOf(maxQ);
                const up = (h & 0xF), down = ((h >> 4) & 0xF), left = ((h >> 8) & 0xF), right = ((h >> 12) & 0xF);
                const tiles = [up, down, left, right];
                if (tiles[idx] === TileFlag.Wall) wallPref++;
            }
        });
        const effective = Math.max(0, seen - wallPref);
        return Math.max(0, Math.min(100, (effective / total) * 100));
    }, [track, qTableData]);
}
