import { TileProperties } from '../hooks/useAddTrack'
import { TrackValidation } from '../types/trackTemplates'

const defaultTile = (): TileProperties => ({
    speed_modifier: 1,
    blocks_movement: false,
    skip_next_turn: false,
    damage: 0,
    is_finish: false,
    is_start: false,
})

// Mirror track horizontally
export const mirrorHorizontal = (layout: TileProperties[][]): TileProperties[][] => {
    return layout.map(row => row.slice().reverse())
}

// Mirror track vertically
export const mirrorVertical = (layout: TileProperties[][]): TileProperties[][] => {
    return layout.slice().reverse()
}

// Rotate track 90 degrees clockwise
export const rotate90 = (layout: TileProperties[][]): TileProperties[][] => {
    const height = layout.length
    const width = layout[0]?.length ?? 0
    const rotated: TileProperties[][] = []

    for (let x = 0; x < width; x++) {
        rotated[x] = []
        for (let y = height - 1; y >= 0; y--) {
            rotated[x][height - 1 - y] = layout[y][x]
        }
    }

    return rotated
}

// Rotate track 180 degrees
export const rotate180 = (layout: TileProperties[][]): TileProperties[][] => {
    return rotate90(rotate90(layout))
}

// Rotate track 270 degrees clockwise
export const rotate270 = (layout: TileProperties[][]): TileProperties[][] => {
    return rotate90(rotate90(rotate90(layout)))
}

// Fill area with selected tile type
export const fillArea = (
    layout: TileProperties[][],
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    tileType: TileProperties
): TileProperties[][] => {
    const newLayout = layout.map(row => row.slice())

    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            if (y >= 0 && y < newLayout.length && x >= 0 && x < newLayout[y].length) {
                newLayout[y][x] = { ...tileType }
            }
        }
    }

    return newLayout
}

// Clear specific tile types
export const clearTileType = (
    layout: TileProperties[][],
    tileType: keyof TileProperties,
    value: any
): TileProperties[][] => {
    return layout.map(row =>
        row.map(tile => {
            if (tile[tileType] === value) {
                return defaultTile()
            }
            return tile
        })
    )
}

// Count tiles of specific type
export const countTileType = (
    layout: TileProperties[][],
    tileType: keyof TileProperties,
    value: any
): number => {
    return layout.reduce((sum, row) =>
        sum + row.filter(tile => tile[tileType] === value).length, 0
    )
}

// Validate track layout
export const validateTrack = (layout: TileProperties[][]): TrackValidation => {
    const errors: string[] = []
    const warnings: string[] = []
    const suggestions: string[] = []

    const height = layout.length
    const width = layout[0]?.length ?? 0

    // Check if layout is empty
    if (height === 0 || width === 0) {
        errors.push('Track layout is empty')
        return { isValid: false, errors, warnings, suggestions }
    }

    // Count start and finish tiles
    const startTiles = countTileType(layout, 'is_start', true)
    const finishTiles = countTileType(layout, 'is_finish', true)

    // Check for start tiles
    if (startTiles === 0) {
        errors.push('Track must have at least one start tile')
    } else if (startTiles > 10) {
        warnings.push(`Track has ${startTiles} start tiles (recommended: 1-5)`)
    }

    // Check for finish tiles
    if (finishTiles === 0) {
        errors.push('Track must have at least one finish tile')
    } else if (finishTiles > 5) {
        warnings.push(`Track has ${finishTiles} finish tiles (recommended: 1-3)`)
    }

    // Check for walled-in areas
    const walledInAreas = findWalledInAreas(layout)
    if (walledInAreas.length > 0) {
        warnings.push(`Track has ${walledInAreas.length} walled-in areas that may be inaccessible`)
    }

    // Check track size
    if (width < 5 || height < 5) {
        warnings.push('Track is very small (minimum recommended: 5x5)')
    }

    if (width > 50 || height > 50) {
        warnings.push('Track is very large (maximum: 50x50)')
    }

    // Suggestions
    if (startTiles === 0 && finishTiles === 0) {
        suggestions.push('Add start and finish tiles to make the track playable')
    }

    if (countTileType(layout, 'speed_modifier', 1) === width * height) {
        suggestions.push('Consider adding boost pads or other special tiles for variety')
    }

    const isValid = errors.length === 0

    return { isValid, errors, warnings, suggestions }
}

// Find walled-in areas (simple flood fill approach)
const findWalledInAreas = (layout: TileProperties[][]): number[][] => {
    const height = layout.length
    const width = layout[0]?.length ?? 0
    const visited = Array.from({ length: height }, () => Array(width).fill(false))
    const areas: number[][] = []

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!visited[y][x] && !layout[y][x].blocks_movement) {
                const area = floodFill(layout, visited, x, y)
                if (area.length > 0 && isWalledIn(layout, area)) {
                    areas.push(...area)
                }
            }
        }
    }

    return areas
}

// Flood fill to find connected areas
const floodFill = (
    layout: TileProperties[][],
    visited: boolean[][],
    startX: number,
    startY: number
): number[][] => {
    const area: number[][] = []
    const stack: [number, number][] = [[startX, startY]]

    while (stack.length > 0) {
        const [x, y] = stack.pop()!

        if (y < 0 || y >= layout.length || x < 0 || x >= layout[y].length || visited[y][x] || layout[y][x].blocks_movement) {
            continue
        }

        visited[y][x] = true
        area.push([x, y])

        // Add adjacent tiles
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }

    return area
}

// Check if an area is walled in
const isWalledIn = (layout: TileProperties[][], area: number[][]): boolean => {
    const height = layout.length
    const width = layout[0]?.length ?? 0

    for (const [x, y] of area) {
        // Check if any adjacent tile is not a wall and not in the area
        const adjacent = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]

        for (const [adjX, adjY] of adjacent) {
            if (adjY >= 0 && adjY < height && adjX >= 0 && adjX < width) {
                if (!layout[adjY][adjX].blocks_movement && !area.some(([ax, ay]) => ax === adjX && ay === adjY)) {
                    return false // Found an exit
                }
            }
        }
    }

    return true // No exit found
}

// Auto-fix common track issues
export const autoFixTrack = (layout: TileProperties[][]): TileProperties[][] => {
    let newLayout = layout.map(row => row.slice())
    const validation = validateTrack(newLayout)

    // Auto-add start tile if missing
    if (countTileType(newLayout, 'is_start', true) === 0) {
        const height = newLayout.length
        const width = newLayout[0]?.length ?? 0
        if (height > 0 && width > 0) {
            newLayout[1][1] = { ...defaultTile(), is_start: true }
        }
    }

    // Auto-add finish tile if missing
    if (countTileType(newLayout, 'is_finish', true) === 0) {
        const height = newLayout.length
        const width = newLayout[0]?.length ?? 0
        if (height > 0 && width > 0) {
            newLayout[height - 2][width - 2] = { ...defaultTile(), is_finish: true }
        }
    }

    return newLayout
}

// Smart path completion between start and finish
export const completePath = (layout: TileProperties[][]): TileProperties[][] => {
    const newLayout = layout.map(row => row.slice())
    const height = newLayout.length
    const width = newLayout[0]?.length ?? 0

    // Find start and finish positions
    let startPos: [number, number] | null = null
    let finishPos: [number, number] | null = null

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (newLayout[y][x].is_start) startPos = [x, y]
            if (newLayout[y][x].is_finish) finishPos = [x, y]
        }
    }

    if (!startPos || !finishPos) return newLayout

    // Simple path completion: create a direct path
    const [startX, startY] = startPos
    const [finishX, finishY] = finishPos

    // Create horizontal path first (but don't overwrite start/finish tiles)
    const stepX = startX < finishX ? 1 : -1
    for (let x = startX; x !== finishX; x += stepX) {
        if (x >= 0 && x < width && startY >= 0 && startY < height) {
            // Don't overwrite start or finish tiles
            if (!newLayout[startY][x].is_start && !newLayout[startY][x].is_finish) {
                newLayout[startY][x] = defaultTile()
            }
        }
    }

    // Create vertical path (but don't overwrite start/finish tiles)
    const stepY = startY < finishY ? 1 : -1
    for (let y = startY; y !== finishY; y += stepY) {
        if (finishX >= 0 && finishX < width && y >= 0 && y < height) {
            // Don't overwrite start or finish tiles
            if (!newLayout[y][finishX].is_start && !newLayout[y][finishX].is_finish) {
                newLayout[y][finishX] = defaultTile()
            }
        }
    }

    return newLayout
}
