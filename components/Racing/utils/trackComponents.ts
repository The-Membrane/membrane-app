import { TileProperties } from '../hooks/useAddTrack'
import { TrackComponent } from '../types/trackTemplates'

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

export const trackComponents: TrackComponent[] = [
    // Corner Components
    {
        name: '90° Corner',
        description: 'Right angle turn',
        width: 3,
        height: 3,
        category: 'corner',
        preview: 'corner-90-preview',
        rotation: true,
        mirror: true,
        layout: [
            [defaultTile(), defaultTile(), defaultTile()],
            [defaultTile(), defaultTile(), createWall()],
            [defaultTile(), createWall(), createWall()]
        ]
    },
    {
        name: '45° Corner',
        description: 'Diagonal turn',
        width: 4,
        height: 4,
        category: 'corner',
        preview: 'corner-45-preview',
        rotation: true,
        mirror: true,
        layout: [
            [defaultTile(), defaultTile(), defaultTile(), defaultTile()],
            [defaultTile(), defaultTile(), defaultTile(), createWall()],
            [defaultTile(), defaultTile(), createWall(), createWall()],
            [defaultTile(), createWall(), createWall(), createWall()]
        ]
    },
    {
        name: '180° Turn',
        description: 'U-turn section',
        width: 5,
        height: 3,
        category: 'corner',
        preview: 'corner-180-preview',
        rotation: true,
        mirror: true,
        layout: [
            [defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile()],
            [createWall(), createWall(), defaultTile(), createWall(), createWall()],
            [defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile()]
        ]
    },

    // Straight Components
    {
        name: 'Short Straight',
        description: '3-tile straight section',
        width: 3,
        height: 1,
        category: 'straight',
        preview: 'straight-short-preview',
        rotation: true,
        mirror: false,
        layout: [
            [defaultTile(), defaultTile(), defaultTile()]
        ]
    },
    {
        name: 'Medium Straight',
        description: '5-tile straight section',
        width: 5,
        height: 1,
        category: 'straight',
        preview: 'straight-medium-preview',
        rotation: true,
        mirror: false,
        layout: [
            [defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile()]
        ]
    },
    {
        name: 'Long Straight',
        description: '8-tile straight section',
        width: 8,
        height: 1,
        category: 'straight',
        preview: 'straight-long-preview',
        rotation: true,
        mirror: false,
        layout: [
            [defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile(), defaultTile()]
        ]
    },

    // Obstacle Components
    {
        name: 'Single Wall',
        description: 'Single wall obstacle',
        width: 1,
        height: 1,
        category: 'obstacle',
        preview: 'obstacle-single-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createWall()]
        ]
    },
    {
        name: 'Wall Block',
        description: '2x2 wall block',
        width: 2,
        height: 2,
        category: 'obstacle',
        preview: 'obstacle-block-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createWall(), createWall()],
            [createWall(), createWall()]
        ]
    },
    {
        name: 'Wall Line',
        description: 'Horizontal wall line',
        width: 3,
        height: 1,
        category: 'obstacle',
        preview: 'obstacle-line-preview',
        rotation: true,
        mirror: false,
        layout: [
            [createWall(), createWall(), createWall()]
        ]
    },

    // Power-up Components
    {
        name: 'Boost Pad',
        description: 'Single boost pad',
        width: 1,
        height: 1,
        category: 'power-up',
        preview: 'powerup-boost-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createBoost()]
        ]
    },
    {
        name: 'Boost Line',
        description: 'Line of boost pads',
        width: 3,
        height: 1,
        category: 'power-up',
        preview: 'powerup-boostline-preview',
        rotation: true,
        mirror: false,
        layout: [
            [createBoost(), createBoost(), createBoost()]
        ]
    },
    {
        name: 'Boost Grid',
        description: '2x2 boost pad grid',
        width: 2,
        height: 2,
        category: 'power-up',
        preview: 'powerup-boostgrid-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createBoost(), createBoost()],
            [createBoost(), createBoost()]
        ]
    },

    // Hazard Components
    {
        name: 'Sticky Patch',
        description: 'Single sticky tile',
        width: 1,
        height: 1,
        category: 'hazard',
        preview: 'hazard-sticky-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createSticky()]
        ]
    },
    {
        name: 'Sticky Line',
        description: 'Line of sticky tiles',
        width: 3,
        height: 1,
        category: 'hazard',
        preview: 'hazard-stickyline-preview',
        rotation: true,
        mirror: false,
        layout: [
            [createSticky(), createSticky(), createSticky()]
        ]
    },
    {
        name: 'Sticky Grid',
        description: '2x2 sticky tile grid',
        width: 2,
        height: 2,
        category: 'hazard',
        preview: 'hazard-stickygrid-preview',
        rotation: false,
        mirror: false,
        layout: [
            [createSticky(), createSticky()],
            [createSticky(), createSticky()]
        ]
    },

    // Start/Finish Components
    {
        name: 'Start Line',
        description: '3-car start line',
        width: 1,
        height: 3,
        category: 'start-finish',
        preview: 'startfinish-startline-preview',
        rotation: true,
        mirror: false,
        layout: [
            [createStart()],
            [createStart()],
            [createStart()]
        ]
    },
    {
        name: 'Finish Line',
        description: '3-car finish line',
        width: 1,
        height: 3,
        category: 'start-finish',
        preview: 'startfinish-finishline-preview',
        rotation: true,
        mirror: false,
        layout: [
            [createFinish()],
            [createFinish()],
            [createFinish()]
        ]
    }
]
