import { TileProperties } from '../hooks/useAddTrack'

export type TrackTemplate = {
    name: string
    description: string
    width: number
    height: number
    layout: TileProperties[][]
    preview: string // Base64 or SVG representation
    category: 'oval' | 'circuit' | 'maze' | 'straight' | 'rally' | 'speedway' | 'time-trial'
}

export type TrackComponent = {
    name: string
    description: string
    width: number
    height: number
    layout: TileProperties[][]
    preview: string
    category: 'corner' | 'straight' | 'obstacle' | 'power-up' | 'hazard' | 'start-finish'
    rotation: boolean // Whether this component can be rotated
    mirror: boolean // Whether this component can be mirrored
}

export type LayoutPattern = {
    name: string
    description: string
    type: 'border' | 'center' | 'grid' | 'spiral' | 'labyrinth' | 'symmetrical'
    apply: (layout: TileProperties[][], options?: any) => TileProperties[][]
}

export type TrackValidation = {
    isValid: boolean
    errors: string[]
    warnings: string[]
    suggestions: string[]
}

export type TrackOperation = {
    type: 'template' | 'component' | 'pattern' | 'utility'
    name: string
    description: string
    action: (layout: TileProperties[][], options?: any) => TileProperties[][]
}
