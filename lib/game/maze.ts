// Deterministic perfect-maze generator for offchain Q-Racing. Pure TS, no DOM — the SAME
// module runs server-side (to pick + verify the maze from a stored seed) and client-side (to
// render the identical maze from the seed the server returns). See docs/OFFCHAIN_QRACING_PLAN.md
// Phase 2. There is no prior maze generator in the repo; this is the canonical implementation.
//
// Algorithm: recursive backtracker (iterative, explicit stack) on an odd-dimension grid, giving
// a perfect maze (exactly one path between any two cells). Finish is placed at the cell farthest
// from the start (BFS). A few 'K' (skip-a-turn) and 'B' (boost) tiles are sprinkled on interior
// corridor cells, deterministically from the same PRNG, avoiding the start/finish approaches so
// every generated maze stays solvable.

import type { TrackTile } from '@/services/q-racing'
import { stepOnce } from '@/lib/game/replay'

export type Maze = {
  grid: TrackTile[][]
  width: number
  height: number
  start: { x: number; y: number }
  finish: { x: number; y: number }
}

/** difficulty 1..5 -> odd square size 9, 11, 13, 15, 17. */
export function mazeSizeForDifficulty(difficulty: number): number {
  const d = Math.max(1, Math.min(5, Math.floor(difficulty || 1)))
  return 7 + d * 2
}

// xorshift32 stream (same family as types/racingTraits.ts:139-145). Guards the zero fixed point
// so a seed of 0 still produces a varied stream.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  if (s === 0) s = 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s >>> 0
  }
}

export function generateMaze(seed: number, difficulty: number): Maze {
  const N = mazeSizeForDifficulty(difficulty)
  const rng = makeRng(seed)

  // Start fully walled; carve passages on odd cells.
  const grid: TrackTile[][] = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => 'W' as TrackTile),
  )

  // Recursive backtracker over odd cells, jumping 2 at a time and knocking out the wall between.
  const startCell = { x: 1, y: 1 }
  grid[startCell.y][startCell.x] = 'E'
  const stack: Array<{ x: number; y: number }> = [startCell]
  const step2: ReadonlyArray<readonly [number, number]> = [
    [0, -2],
    [0, 2],
    [-2, 0],
    [2, 0],
  ]

  while (stack.length > 0) {
    const cur = stack[stack.length - 1]
    const neighbours: Array<readonly [number, number]> = []
    for (const [dx, dy] of step2) {
      const nx = cur.x + dx
      const ny = cur.y + dy
      if (nx > 0 && ny > 0 && nx < N - 1 && ny < N - 1 && grid[ny][nx] === 'W') {
        neighbours.push([dx, dy])
      }
    }
    if (neighbours.length === 0) {
      stack.pop()
      continue
    }
    const [dx, dy] = neighbours[rng() % neighbours.length]
    grid[cur.y + dy / 2][cur.x + dx / 2] = 'E' // knock the wall between the two cells
    const nx = cur.x + dx
    const ny = cur.y + dy
    grid[ny][nx] = 'E'
    stack.push({ x: nx, y: ny })
  }

  // Farthest passage cell from the start (BFS) becomes the finish.
  const finish = farthestCell(grid, startCell)

  // Sprinkle specials before stamping S/F so those cells are naturally excluded.
  sprinkleSpecials(grid, rng, startCell, finish, difficulty)

  grid[startCell.y][startCell.x] = 'S'
  grid[finish.y][finish.x] = 'F'

  return { grid, width: N, height: N, start: startCell, finish }
}

function farthestCell(
  grid: TrackTile[][],
  start: { x: number; y: number },
): { x: number; y: number } {
  const N = grid.length
  const dist: number[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => -1))
  const queue: Array<{ x: number; y: number }> = [start]
  dist[start.y][start.x] = 0
  let best = start
  let bestDist = 0
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ]
  while (queue.length > 0) {
    const cur = queue.shift() as { x: number; y: number }
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx
      const ny = cur.y + dy
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue
      if (grid[ny][nx] === 'W' || dist[ny][nx] !== -1) continue
      dist[ny][nx] = dist[cur.y][cur.x] + 1
      if (dist[ny][nx] > bestDist) {
        bestDist = dist[ny][nx]
        best = { x: nx, y: ny }
      }
      queue.push({ x: nx, y: ny })
    }
  }
  return best
}

// Places `difficulty` K tiles and `difficulty` B tiles on interior corridor cells. Excludes the
// start, the finish, and every cell adjacent (Manhattan distance 1) to either, so the approaches
// stay clean and the maze remains provably solvable.
function sprinkleSpecials(
  grid: TrackTile[][],
  rng: () => number,
  start: { x: number; y: number },
  finish: { x: number; y: number },
  difficulty: number,
): void {
  const near = (x: number, y: number, p: { x: number; y: number }) =>
    Math.abs(x - p.x) + Math.abs(y - p.y) <= 1

  const eligible: Array<{ x: number; y: number }> = []
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      if (grid[y][x] !== 'E') continue
      if (near(x, y, start) || near(x, y, finish)) continue
      eligible.push({ x, y })
    }
  }

  // Deterministic partial Fisher-Yates so selection depends only on the seed.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = rng() % (i + 1)
    const tmp = eligible[i]
    eligible[i] = eligible[j]
    eligible[j] = tmp
  }

  const d = Math.max(1, Math.min(5, Math.floor(difficulty || 1)))
  let idx = 0
  for (let k = 0; k < d && idx < eligible.length; k++, idx++) {
    const c = eligible[idx]
    grid[c.y][c.x] = 'K'
  }
  for (let b = 0; b < d && idx < eligible.length; b++, idx++) {
    const c = eligible[idx]
    grid[c.y][c.x] = 'B'
  }
}

/**
 * BFS shortest move-sequence that reaches the finish under the real tile semantics (via
 * stepOnce). State = (x, y, stuck). Returns [] if unreachable (never happens for a maze from
 * generateMaze). Not used by the game routes; it exists for tests and as a possible client hint.
 */
export function solveMaze(maze: Maze): number[] {
  const { grid, start } = maze
  const key = (x: number, y: number, s: boolean) => `${x},${y},${s ? 1 : 0}`
  const prev = new Map<string, { k: string; dir: number } | null>()
  prev.set(key(start.x, start.y, false), null)
  const queue: Array<{ x: number; y: number; s: boolean }> = [
    { x: start.x, y: start.y, s: false },
  ]

  while (queue.length > 0) {
    const cur = queue.shift() as { x: number; y: number; s: boolean }
    for (let dir = 0; dir < 4; dir++) {
      const r = stepOnce(grid, cur.x, cur.y, dir, cur.s)
      if (r.finished) {
        const moves: number[] = []
        let node = key(cur.x, cur.y, cur.s)
        while (prev.get(node)) {
          const p = prev.get(node) as { k: string; dir: number }
          moves.push(p.dir)
          node = p.k
        }
        moves.reverse()
        moves.push(dir)
        return moves
      }
      const k = key(r.x, r.y, r.stuck)
      if (!prev.has(k)) {
        prev.set(k, { k: key(cur.x, cur.y, cur.s), dir })
        queue.push({ x: r.x, y: r.y, s: r.stuck })
      }
    }
  }
  return []
}
