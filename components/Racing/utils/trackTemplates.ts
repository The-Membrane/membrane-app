import { TileProperties } from '../hooks/useAddTrack'
import { TrackTemplate } from '../types/trackTemplates'

const defaultTile = (): TileProperties => ({
    speed_modifier: 1,
    blocks_movement: false,
    skip_next_turn: false,
    damage: 0,
    is_finish: false,
    is_start: false,
})

const createWall = (): TileProperties => ({ ...defaultTile(), blocks_movement: true })
const createStart = (): TileProperties => ({ ...defaultTile(), is_start: true })
const createFinish = (): TileProperties => ({ ...defaultTile(), is_finish: true })
const createBoost = (): TileProperties => ({ ...defaultTile(), speed_modifier: 3 })
const createSticky = (): TileProperties => ({ ...defaultTile(), skip_next_turn: true })

export const trackTemplates: TrackTemplate[] = [
    {
        name: 'Oval Track',
        description: 'Classic racing oval with start/finish line',
        width: 20,
        height: 15,
        category: 'oval',
        preview: 'oval-preview',
        layout: [
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()]
        ]
    },
    {
        name: 'Straight Line',
        description: 'Simple drag race track',
        width: 20,
        height: 8,
        category: 'straight',
        preview: 'straight-preview',
        layout: [
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish(), createWall()],
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()]
        ]
    },
    {
        name: 'Figure-8',
        description: 'Intersecting track with crossover',
        width: 20,
        height: 15,
        category: 'circuit',
        preview: 'figure8-preview',
        layout: [
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()],
            [createWall(), createStart(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createWall()],
            [createWall(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), createFinish()],
            [createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall(), createWall()]
        ]
    },
    {
        name: 'Maze',
        description: 'Complex track with multiple paths and dead ends',
        width: 20,
        height: 20,
        category: 'maze',
        preview: 'maze-preview',
        layout: Array.from({ length: 20 }, (_, y) =>
            Array.from({ length: 20 }, (_, x) => {
                if (x === 0 || x === 19 || y === 0 || y === 19) return createWall()
                if (x === 1 && y === 1) return createStart()
                if (x === 18 && y === 18) return createFinish()
                // Create maze pattern with some walls
                if ((x % 3 === 0 && y % 3 === 0) || (x === 10 && y > 5 && y < 15)) return createWall()
                return defaultTile()
            })
        )
    }
]
