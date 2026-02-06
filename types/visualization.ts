// Visualization data types for the cyberpunk mycelium network

export interface MarketNode {
    id: string
    name: string
    type: 'collateral' | 'disco_tranche' | 'transmuter' | 'manic_loop' | 'system'
    position: [number, number, number] // 3D position
    size: number // Visual size based on TVL/volume
    tvl: number
    risk: number // 0-1 risk score
    ltv?: number // For collateral markets
    trancheLevel?: number // For disco tranches
    color: string // Hex color
    glowIntensity: number // 0-1 for risk visualization
    recentActivity: number // Activity score for pulse animation
    metadata: {
        asset?: string
        maxLTV?: number
        maxBorrowLTV?: number
        depositTokens?: number
        vaultTokens?: number
        [key: string]: any
    }
}

export interface FlowEdge {
    id: string
    source: string // Market node ID
    target: string // Market node ID
    type: 'swap' | 'deposit' | 'withdraw' | 'liquidation' | 'loop' | 'revenue'
    volume: number
    intensity: number // 0-1 for tendril thickness
    color: string
    animated: boolean // Whether to show flow animation
    timestamp: number
    metadata: {
        amount?: number
        asset?: string
        [key: string]: any
    }
}

export interface SystemEvent {
    id: string
    type: 'cdp_open' | 'cdp_repay' | 'liquidation' | 'disco_deposit' | 'disco_withdraw' |
    'transmuter_swap' | 'manic_loop' | 'revenue_distribution'
    marketId: string
    timestamp: number
    magnitude: number // 0-1 for visualization intensity
    position?: [number, number, number] // 3D position for galaxy view
    data: {
        amount?: number
        asset?: string
        user?: string
        positionId?: string
        [key: string]: any
    }
}

export interface TimelineData {
    timestamps: number[]
    cdtSupply: number[]
    mbrnAtRisk: number[]
    liquidationClusters: {
        timestamp: number
        count: number
        totalAmount: number
        positions: string[]
    }[]
    riskMetrics: {
        timestamp: number
        overallRisk: number
        marketRisks: Record<string, number>
    }[]
}

export interface MarketMetrics {
    tvl: number
    volume24h: number
    riskScore: number
    ltv: number
    maxLTV: number
    maxBorrowLTV: number
    depositTokens: number
    vaultTokens: number
    recentEvents: SystemEvent[]
}

export interface VisualizationConfig {
    colors: {
        background: string
        primary: string
        secondary: string
        accent: string
        risk: {
            low: string
            medium: string
            high: string
            critical: string
        }
        event: {
            cdp_open: string
            cdp_repay: string
            liquidation: string
            disco_deposit: string
            disco_withdraw: string
            transmuter_swap: string
            manic_loop: string
        }
    }
    animations: {
        pulseDuration: number
        flowSpeed: number
        rippleSpeed: number
        glowPulse: number
    }
    lod: {
        near: number
        medium: number
        far: number
    }
}

export const DEFAULT_VIS_CONFIG: VisualizationConfig = {
    colors: {
        background: '#0a0a0f',
        primary: '#8a2be2', // BlueViolet
        secondary: '#00bfff', // DeepSkyBlue
        accent: '#ff00ff', // Magenta
        risk: {
            low: '#00ff00', // Green
            medium: '#ffff00', // Yellow
            high: '#ff8800', // Orange
            critical: '#ff0000', // Red
        },
        event: {
            cdp_open: '#00bfff',
            cdp_repay: '#00ff00',
            liquidation: '#ff0000',
            disco_deposit: '#8a2be2',
            disco_withdraw: '#9370db',
            transmuter_swap: '#ff00ff',
            manic_loop: '#ff1493',
        },
    },
    animations: {
        pulseDuration: 2000,
        flowSpeed: 0.5,
        rippleSpeed: 1.0,
        glowPulse: 3000,
    },
    lod: {
        near: 50,
        medium: 200,
        far: 500,
    },
}

