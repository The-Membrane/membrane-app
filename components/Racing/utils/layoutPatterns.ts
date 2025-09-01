import { TileProperties } from '../hooks/useAddTrack'
import { LayoutPattern } from '../types/trackTemplates'

const defaultTile = (): TileProperties => ({
    speed_modifier: 1,
    blocks_movement: false,
    skip_next_turn: false,
    damage: 0,
    is_finish: false,
    is_start: false,
})

const createWall = (): TileProperties => ({ ...defaultTile(), blocks_movement: true })

export const layoutPatterns: LayoutPattern[] = [
    {
        name: 'Border Walls',
        description: 'Add walls around the entire track perimeter',
        type: 'border',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            // Add walls to top and bottom rows
            for (let x = 0; x < width; x++) {
                if (newLayout[0]) newLayout[0][x] = createWall()
                if (newLayout[height - 1]) newLayout[height - 1][x] = createWall()
            }

            // Add walls to left and right columns
            for (let y = 0; y < height; y++) {
                if (newLayout[y] && newLayout[y][0]) newLayout[y][0] = createWall()
                if (newLayout[y] && newLayout[y][width - 1]) newLayout[y][width - 1] = createWall()
            }

            return newLayout
        }
    },
    {
        name: 'Center Obstacle',
        description: 'Add a central obstacle block',
        type: 'center',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            const centerX = Math.floor(width / 2)
            const centerY = Math.floor(height / 2)

            // Create a 3x3 obstacle in the center
            for (let y = centerY - 1; y <= centerY + 1; y++) {
                for (let x = centerX - 1; x <= centerX + 1; x++) {
                    if (y >= 0 && y < height && x >= 0 && x < width && newLayout[y]) {
                        newLayout[y][x] = createWall()
                    }
                }
            }

            return newLayout
        }
    },
    {
        name: 'Grid Pattern',
        description: 'Add a checkerboard pattern of walls',
        type: 'grid',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (newLayout[y] && (x + y) % 2 === 0) {
                        newLayout[y][x] = createWall()
                    }
                }
            }

            return newLayout
        }
    },
    {
        name: 'Spiral Pattern',
        description: 'Create a spiral wall pattern',
        type: 'spiral',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            let x = 0, y = 0
            let dx = 1, dy = 0
            let steps = width
            let stepCount = 0

            for (let i = 0; i < width * height; i++) {
                if (y >= 0 && y < height && x >= 0 && x < width && newLayout[y]) {
                    newLayout[y][x] = createWall()
                }

                x += dx
                y += dy
                stepCount++

                if (stepCount === steps) {
                    stepCount = 0
                    // Rotate direction
                    const temp = dx
                    dx = -dy
                    dy = temp
                    if (dx === 0) steps--
                }
            }

            return newLayout
        }
    },
    {
        name: 'Labyrinth Pattern',
        description: 'Create a maze-like pattern with walls',
        type: 'labyrinth',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            // Create vertical walls every 3 columns
            for (let y = 0; y < height; y++) {
                for (let x = 3; x < width; x += 3) {
                    if (newLayout[y] && newLayout[y][x]) {
                        newLayout[y][x] = createWall()
                    }
                }
            }

            // Create horizontal walls every 3 rows
            for (let y = 3; y < height; y += 3) {
                for (let x = 0; x < width; x++) {
                    if (newLayout[y] && newLayout[y][x]) {
                        newLayout[y][x] = createWall()
                    }
                }
            }

            return newLayout
        }
    },
    {
        name: 'Symmetrical Pattern',
        description: 'Create a symmetrical wall pattern',
        type: 'symmetrical',
        apply: (layout: TileProperties[][]) => {
            const newLayout = layout.map(row => row.slice())
            const height = newLayout.length
            const width = newLayout[0]?.length ?? 0

            const centerX = Math.floor(width / 2)
            const centerY = Math.floor(height / 2)

            // Create symmetrical walls
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (newLayout[y] && (x === centerX || y === centerY)) {
                        newLayout[y][x] = createWall()
                    }
                }
            }

            return newLayout
        }
    }
]
