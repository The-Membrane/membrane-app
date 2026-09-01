// Server-authoritative maze replay — THE anti-cheat verifier for offchain Q-Racing.
// See docs/OFFCHAIN_QRACING_PLAN.md (Phase 2): the client posts only its move path; the
// server regenerates the seeded maze and replays the path here. A maze solution is cheap to
// verify, so this is real anti-cheat, not a heuristic.
//
// Pure TS, no DOM — runs identically in the API route and (for live rendering) the client.
// Tile semantics mirror the single-car branch of apply_tile_effects_to_car in the Rust source
// of truth, membrane-core/contracts/race-engine/src/contract.rs:1413-1470
// (blocks_movement bounces, skip_next_turn flags a skipped turn, is_finish wins, speed_modifier
// > 1 = boost). Multi-car RPS collision logic is intentionally NOT ported — offchain runs solo.

import type { TrackTile } from '@/services/q-racing'
import type { Maze } from '@/lib/game/maze'

// Canonical move encoding, matching components/Racing/hooks/useRaceAnimation.ts:274-289:
// 0 = Up (y-1), 1 = Down (y+1), 2 = Left (x-1), 3 = Right (x+1).
export const MOVE_DELTAS: Readonly<Record<number, readonly [number, number]>> = {
  0: [0, -1],
  1: [0, 1],
  2: [-1, 0],
  3: [1, 0],
}

function tileAt(grid: TrackTile[][], x: number, y: number): TrackTile | null {
  if (y < 0 || x < 0 || y >= grid.length || x >= grid[0].length) return null
  return grid[y][x]
}

export type StepResult = { x: number; y: number; stuck: boolean; finished: boolean }

/**
 * Apply ONE move to a single car and return its new state. Encapsulates all tile semantics so
 * both replayPath (verification) and solveMaze (test/hint) share identical rules.
 *
 * - stuck: the previous tile was 'K' — this move is consumed but the car does not move.
 * - out of bounds / 'W': bounce, stay in place (border walls make OOB unreachable in practice).
 * - 'F': move onto finish, win.
 * - 'K': move on, then flag skip-next-turn.
 * - 'B': move onto the boost tile, then carry ONE extra cell in the same direction if not
 *        blocked (a wall/edge stops the carry on the boost tile; a finish there wins).
 * - 'E'/'S': normal move.
 * A malformed direction is treated as a wasted move (no position change) — keeps callers total.
 */
export function stepOnce(
  grid: TrackTile[][],
  x: number,
  y: number,
  dir: number,
  stuck: boolean,
): StepResult {
  if (stuck) return { x, y, stuck: false, finished: false }

  const delta = MOVE_DELTAS[dir as 0 | 1 | 2 | 3]
  if (!delta) return { x, y, stuck: false, finished: false }

  const [dx, dy] = delta
  const tx = x + dx
  const ty = y + dy
  const t = tileAt(grid, tx, ty)

  if (t === null || t === 'W') return { x, y, stuck: false, finished: false }
  if (t === 'F') return { x: tx, y: ty, stuck: false, finished: true }
  if (t === 'K') return { x: tx, y: ty, stuck: true, finished: false }

  if (t === 'B') {
    const ex = tx + dx
    const ey = ty + dy
    const et = tileAt(grid, ex, ey)
    if (et === null || et === 'W') return { x: tx, y: ty, stuck: false, finished: false }
    if (et === 'F') return { x: ex, y: ey, stuck: false, finished: true }
    if (et === 'K') return { x: ex, y: ey, stuck: true, finished: false }
    return { x: ex, y: ey, stuck: false, finished: false }
  }

  return { x: tx, y: ty, stuck: false, finished: false }
}

export type ReplayResult = {
  finished: boolean
  ticks: number
  finalPos: { x: number; y: number }
}

/**
 * Replay a move path against a maze. Total: never throws on malformed input — a bad maze or a
 * non-array `moves` yields finished:false. Every move consumes exactly one tick (walls
 * included). Ticks are hard-capped at width*height*2 (player-navigated cap per the plan);
 * moves past the cap are ignored.
 */
export function replayPath(maze: Maze, moves: number[]): ReplayResult {
  const grid = maze?.grid
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
    return { finished: false, ticks: 0, finalPos: { x: 0, y: 0 } }
  }

  const width = grid[0].length
  const height = grid.length
  const cap = width * height * 2

  const start = maze.start ?? { x: 0, y: 0 }
  let x = start.x
  let y = start.y
  let stuck = false
  let ticks = 0

  const list = Array.isArray(moves) ? moves : []
  for (let i = 0; i < list.length; i++) {
    if (ticks >= cap) break
    ticks += 1
    const res = stepOnce(grid, x, y, Number(list[i]), stuck)
    x = res.x
    y = res.y
    stuck = res.stuck
    if (res.finished) return { finished: true, ticks, finalPos: { x, y } }
  }

  return { finished: false, ticks, finalPos: { x, y } }
}
