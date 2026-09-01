import { describe, expect, it } from 'vitest'

import { generateMaze, mazeSizeForDifficulty, solveMaze, type Maze } from '@/lib/game/maze'
import { replayPath } from '@/lib/game/replay'

// TrackTile is 'W' | 'E' | 'F' | 'S' | 'K' | 'B' (services/q-racing.ts). We build synthetic
// mazes below with the same alphabet, cast through unknown to avoid importing the runtime module.
type Tile = 'W' | 'E' | 'F' | 'S' | 'K' | 'B'
const maze = (grid: Tile[][], start: { x: number; y: number }, finish: { x: number; y: number }): Maze =>
  ({
    grid: grid as unknown as Maze['grid'],
    width: grid[0].length,
    height: grid.length,
    start,
    finish,
  })

describe('generateMaze — determinism', () => {
  it('same seed + difficulty yields an identical grid', () => {
    const a = generateMaze(12345, 3)
    const b = generateMaze(12345, 3)
    expect(a).toEqual(b)
  })

  it('different seeds diverge', () => {
    const a = generateMaze(1, 3)
    const b = generateMaze(2, 3)
    expect(a.grid).not.toEqual(b.grid)
  })

  it('difficulty maps to odd sizes 9..17 with border walls and an S/F', () => {
    expect(mazeSizeForDifficulty(1)).toBe(9)
    expect(mazeSizeForDifficulty(5)).toBe(17)
    const m = generateMaze(7, 2)
    expect(m.width).toBe(11)
    expect(m.grid[0].every((t) => t === 'W')).toBe(true) // top border walls
    expect(m.grid[m.start.y][m.start.x]).toBe('S')
    expect(m.grid[m.finish.y][m.finish.x]).toBe('F')
  })
})

describe('replayPath — verification against generated mazes', () => {
  it('a solved path verifies and stays within the tick cap', () => {
    for (const seed of [1, 42, 999, 250000]) {
      for (const diff of [1, 3, 5]) {
        const m = generateMaze(seed, diff)
        const cap = m.width * m.height * 2
        const solution = solveMaze(m)
        expect(solution.length).toBeGreaterThan(0)
        const r = replayPath(m, solution)
        expect(r.finished).toBe(true)
        expect(r.ticks).toBeLessThanOrEqual(cap)
        expect(r.finalPos).toEqual(m.finish)
      }
    }
  })

  it('wall-spam never finishes (all moves into the border wall)', () => {
    const m = generateMaze(42, 3)
    const r = replayPath(m, new Array(50).fill(0)) // Up from the start corner = wall
    expect(r.finished).toBe(false)
    expect(r.finalPos).toEqual(m.start)
    expect(r.ticks).toBe(50)
  })

  it('caps ticks at width*height*2', () => {
    const m = generateMaze(42, 1)
    const cap = m.width * m.height * 2
    const r = replayPath(m, new Array(cap + 500).fill(0))
    expect(r.ticks).toBe(cap)
    expect(r.finished).toBe(false)
  })
})

describe('replayPath — tile semantics', () => {
  it("'K' consumes an extra skipped turn", () => {
    // S(1,1) K(2,1) F(3,1) in a straight corridor.
    const m = maze(
      [
        ['W', 'W', 'W', 'W', 'W'],
        ['W', 'S', 'K', 'F', 'W'],
        ['W', 'W', 'W', 'W', 'W'],
      ],
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    )
    // Right onto K (stuck), Right skipped, Right onto F.
    expect(replayPath(m, [3, 3]).finished).toBe(false) // skip eats the 2nd move
    const r = replayPath(m, [3, 3, 3])
    expect(r.finished).toBe(true)
    expect(r.ticks).toBe(3)
    expect(r.finalPos).toEqual({ x: 3, y: 1 })
  })

  it("'B' carries one extra cell in the same direction", () => {
    // S(1,1) B(2,1) E(3,1) F(4,1): stepping onto B lands on the E past it in one tick.
    const m = maze(
      [
        ['W', 'W', 'W', 'W', 'W', 'W'],
        ['W', 'S', 'B', 'E', 'F', 'W'],
        ['W', 'W', 'W', 'W', 'W', 'W'],
      ],
      { x: 1, y: 1 },
      { x: 4, y: 1 },
    )
    const afterBoost = replayPath(m, [3])
    expect(afterBoost.finalPos).toEqual({ x: 3, y: 1 }) // skipped the E cell
    expect(afterBoost.ticks).toBe(1)
    const r = replayPath(m, [3, 3])
    expect(r.finished).toBe(true)
    expect(r.ticks).toBe(2)
  })

  it("'B' can carry straight onto the finish", () => {
    const m = maze(
      [
        ['W', 'W', 'W', 'W', 'W'],
        ['W', 'S', 'B', 'F', 'W'],
        ['W', 'W', 'W', 'W', 'W'],
      ],
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    )
    const r = replayPath(m, [3])
    expect(r.finished).toBe(true)
    expect(r.ticks).toBe(1)
  })

  it('walls bounce: a move into a wall consumes a tick but does not move', () => {
    const m = maze(
      [
        ['W', 'W', 'W', 'W'],
        ['W', 'S', 'F', 'W'],
        ['W', 'W', 'W', 'W'],
      ],
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    )
    // Up (wall), Up (wall), Right (finish).
    const r = replayPath(m, [0, 0, 3])
    expect(r.finished).toBe(true)
    expect(r.ticks).toBe(3)
  })
})

describe('replayPath — totality on malformed input', () => {
  it('never throws on bad input', () => {
    // @ts-expect-error intentional bad maze
    expect(replayPath(null, [1, 2, 3]).finished).toBe(false)
    const m = generateMaze(1, 1)
    // @ts-expect-error intentional bad moves
    expect(replayPath(m, 'nope').finished).toBe(false)
    expect(replayPath(m, [9, -1, 4, 3, 2]).finished).toBeDefined()
  })
})
