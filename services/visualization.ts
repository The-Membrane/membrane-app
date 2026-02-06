import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'
import type { MarketNode, FlowEdge, SystemEvent, TimelineData } from '@/types/visualization'
import { getLTVQueue } from './disco'

interface VisualizationDataResponse {
    markets: MarketNode[]
    flows: FlowEdge[]
    events: SystemEvent[]
    timelineData: TimelineData
}

/**
 * Main function to fetch all visualization data
 */
export const getVisualizationData = async (
    client: CosmWasmClient,
    timeRange: '1h' | '24h' | '7d' | '30d'
): Promise<VisualizationDataResponse> => {
    const now = Math.floor(Date.now() / 1000)
    const timeRangeSeconds = {
        '1h': 3600,
        '24h': 86400,
        '7d': 604800,
        '30d': 2592000,
    }[timeRange]

    const startTime = now - timeRangeSeconds

    // Fetch data in parallel
    const [markets, flows, events, timelineData] = await Promise.all([
        getMarkets(client),
        getFlows(client, startTime, now),
        getEvents(client, startTime, now),
        getTimelineData(client, startTime, now),
    ])

    return {
        markets,
        flows,
        events,
        timelineData,
    }
}

/**
 * Fetch market nodes - Only 3 nodes: Transmuter, LTV Disco, Manic Loops
 */
async function getMarkets(client: CosmWasmClient): Promise<MarketNode[]> {
    const markets: MarketNode[] = []
    const triangleRadius = 15

    try {
        // Transmuter - Top of triangle
        let transmuterUSDC = 0
        if (contracts.transmuter) {
            try {
                const vaultInfo = await client.queryContractSmart(contracts.transmuter, {
                    vault_info: {},
                })
                transmuterUSDC = Number(vaultInfo?.paired_asset_balance || 0)
            } catch (error) {
                console.warn('Error fetching transmuter vault info:', error)
            }
        }

        markets.push({
            id: 'transmuter',
            name: 'Transmuter',
            type: 'transmuter',
            position: [0, triangleRadius, 0], // Top
            size: 4,
            tvl: transmuterUSDC,
            risk: 0.3,
            color: '#ff00ff', // Magenta
            glowIntensity: 0.5,
            recentActivity: 0.4,
            metadata: {
                usdcBalance: transmuterUSDC,
            },
        })

        // LTV Disco - Bottom left
        let discoRevenue = 0
        if (contracts.ltv_disco) {
            try {
                // Estimate annual revenue from total insurance and recent revenue events
                const totalInsurance = await client.queryContractSmart(contracts.ltv_disco, {
                    get_total_insurance: {},
                })
                // Rough estimate: assume 5% annual yield on insurance
                const insuranceValue = totalInsurance?.total_insurance_cdt
                    ? Number(totalInsurance.total_insurance_cdt)
                    : 0
                discoRevenue = insuranceValue * 0.05
            } catch (error) {
                console.warn('Error fetching disco revenue:', error)
            }
        }

        markets.push({
            id: 'ltv_disco',
            name: 'LTV Disco',
            type: 'disco_tranche',
            position: [
                -triangleRadius * Math.cos(Math.PI / 6),
                -triangleRadius * Math.sin(Math.PI / 6),
                0,
            ], // Bottom left
            size: 3.5,
            tvl: 0,
            risk: 0.4,
            color: '#8a2be2', // Purple
            glowIntensity: 0.6,
            recentActivity: 0.3,
            metadata: {
                estimatedAnnualRevenue: discoRevenue,
            },
        })

        // Manic Loops (Yield Arb) - Bottom right
        let recentVolume = 0
        if (contracts.yield_arb && contracts.transmuter) {
            try {
                // Get global rate limit from transmuter to estimate recent volume
                const globalRateLimit = await client.queryContractSmart(contracts.transmuter, {
                    global_rate_limit: {},
                })
                // Use net_total as proxy for recent volume
                recentVolume = Math.abs(Number(globalRateLimit?.net_total || 0))
            } catch (error) {
                console.warn('Error fetching rate limit:', error)
            }
        }

        markets.push({
            id: 'manic_loops',
            name: 'Manic Loops',
            type: 'manic_loop',
            position: [
                triangleRadius * Math.cos(Math.PI / 6),
                -triangleRadius * Math.sin(Math.PI / 6),
                0,
            ], // Bottom right
            size: 3.5,
            tvl: 0,
            risk: 0.5,
            color: '#00bfff', // Cyan
            glowIntensity: 0.7,
            recentActivity: 0.5,
            metadata: {
                recentVolume,
            },
        })
    } catch (error) {
        console.error('Error fetching markets:', error)
    }

    // If no markets found, use mock data
    if (markets.length === 0) {
        return getMockMarkets()
    }

    return markets
}

/**
 * Fetch flow edges - Only 2 flows: Transmuter->Manic, Manic->Disco
 */
async function getFlows(
    client: CosmWasmClient,
    startTime: number,
    endTime: number
): Promise<FlowEdge[]> {
    const flows: FlowEdge[] = []

    try {
        // Get markets to access their metadata
        const markets = await getMarkets(client)
        const transmuterMarket = markets.find(m => m.id === 'transmuter')
        const manicMarket = markets.find(m => m.id === 'manic_loops')
        const discoMarket = markets.find(m => m.id === 'ltv_disco')

        // Flow 1: Transmuter to Manic Loops
        if (transmuterMarket && manicMarket) {
            const usdcBalance = transmuterMarket.metadata.usdcBalance || 0
            const recentVolume = manicMarket.metadata.recentVolume || 0

            // Get rate limit from transmuter for yield-arb address if available
            if (contracts.yield_arb && contracts.transmuter) {
                try {
                    const yieldArbConfig = await client.queryContractSmart(contracts.yield_arb, {
                        config: {},
                    })
                    const yieldArbAddr = yieldArbConfig?.transmuter_addr || contracts.yield_arb

                    // Query rate limit for yield-arb address
                    const rateLimit = await client.queryContractSmart(contracts.transmuter, {
                        rate_limit_many: {
                            addresses: [yieldArbAddr],
                        },
                    })

                    if (rateLimit?.statuses?.[0]) {
                        const netTotal = Math.abs(Number(rateLimit.statuses[0].net_total || 0))
                        manicMarket.metadata.recentVolume = netTotal
                    }
                } catch (error) {
                    console.warn('Error fetching rate limit for yield-arb:', error)
                }
            }

            // Flow width (intensity) based on USDC balance
            const maxUSDC = 5000000
            const flowIntensity = Math.min(1, usdcBalance / maxUSDC)

            // Flow speed based on recent volume
            const maxVolume = 2000000
            const flowSpeed = Math.min(2, 0.5 + (recentVolume / maxVolume) * 1.5)

            flows.push({
                id: 'transmuter_to_manic',
                source: 'transmuter',
                target: 'manic_loops',
                type: 'swap',
                volume: recentVolume,
                intensity: Math.max(0.2, flowIntensity),
                color: '#ff00ff',
                animated: true,
                timestamp: Math.floor(Date.now() / 1000),
                metadata: {
                    usdcBalance,
                    recentVolume,
                    flowSpeed,
                },
            })
        }

        // Flow 2: Manic Loops to LTV Disco
        if (manicMarket && discoMarket) {
            const estimatedAnnualRevenue = discoMarket.metadata.estimatedAnnualRevenue || 0

            flows.push({
                id: 'manic_to_disco',
                source: 'manic_loops',
                target: 'ltv_disco',
                type: 'revenue',
                volume: estimatedAnnualRevenue / 365, // Daily revenue
                intensity: 0.6, // Constant intensity
                color: '#8a2be2',
                animated: true,
                timestamp: Math.floor(Date.now() / 1000),
                metadata: {
                    estimatedAnnualRevenue,
                    flowSpeed: 0.5, // Constant speed
                },
            })
        }
    } catch (error) {
        console.error('Error fetching flows:', error)
    }

    // If no flows found, use mock data
    if (flows.length === 0) {
        return getMockFlows(startTime, endTime)
    }

    return flows
}

/**
 * Fetch system events
 */
async function getEvents(
    client: CosmWasmClient,
    startTime: number,
    endTime: number
): Promise<SystemEvent[]> {
    const events: SystemEvent[] = []

    try {
        // Get liquidation stats from CDP
        if (contracts.cdp) {
            try {
                const liquidationStats = await client.queryContractSmart(contracts.cdp, {
                    liquidation_stats: {},
                })

                if (liquidationStats?.stats) {
                    liquidationStats.stats.forEach((stat: any) => {
                        const timestamp = stat.block_time || 0
                        if (timestamp >= startTime && timestamp <= endTime) {
                            events.push({
                                id: `liq_${stat.position_id}_${timestamp}`,
                                type: 'liquidation',
                                marketId: `collateral_${stat.collateral_assets?.[0]?.info?.native_token?.denom || 'unknown'}`,
                                timestamp,
                                magnitude: Math.min(1, Number(stat.amount_liquidated || 0) / 1000000),
                                data: {
                                    amount: Number(stat.amount_liquidated || 0),
                                    positionId: stat.position_id,
                                },
                            })
                        }
                    })
                }
            } catch (error) {
                console.warn('Error fetching liquidation stats:', error)
            }
        }
    } catch (error) {
        console.error('Error fetching events:', error)
    }

    // If no events found, use mock data
    if (events.length === 0) {
        return getMockEvents(startTime, endTime)
    }

    return events
}

/**
 * Fetch timeline data (CDT supply, MBRN at risk, liquidation clusters)
 */
async function getTimelineData(
    client: CosmWasmClient,
    startTime: number,
    endTime: number
): Promise<TimelineData> {
    const timestamps: number[] = []
    const cdtSupply: number[] = []
    const mbrnAtRisk: number[] = []
    const liquidationClusters: TimelineData['liquidationClusters'] = []
    const riskMetrics: TimelineData['riskMetrics'] = []

    try {
        // Get CDT supply history
        if (contracts.cdp) {
            try {
                const cdtSupplyHistory = await client.queryContractSmart(contracts.cdp, {
                    cdt_supply: {},
                })

                if (cdtSupplyHistory?.supply) {
                    cdtSupplyHistory.supply.forEach((entry: any) => {
                        const timestamp = entry.timestamp || 0
                        if (timestamp >= startTime && timestamp <= endTime) {
                            timestamps.push(timestamp)
                            cdtSupply.push(Number(entry.supply || 0))
                        }
                    })
                }
            } catch (error) {
                console.warn('Error fetching CDT supply:', error)
            }
        }

        // Get total insurance (MBRN at risk)
        if (contracts.ltv_disco) {
            try {
                const totalInsurance = await client.queryContractSmart(contracts.ltv_disco, {
                    get_total_insurance: {},
                })

                // For now, use a constant or calculate from deposits
                // This would need more sophisticated calculation
                const insuranceValue = totalInsurance?.total_insurance_cdt
                    ? Number(totalInsurance.total_insurance_cdt)
                    : 0

                // Create time series (simplified - would need actual historical data)
                for (let i = 0; i < timestamps.length; i++) {
                    mbrnAtRisk.push(insuranceValue)
                }
            } catch (error) {
                console.warn('Error fetching total insurance:', error)
            }
        }
    } catch (error) {
        console.error('Error fetching timeline data:', error)
    }

    // If no timeline data, use mock data
    if (timestamps.length === 0) {
        return getMockTimelineData(startTime, endTime)
    }

    return {
        timestamps,
        cdtSupply,
        mbrnAtRisk,
        liquidationClusters,
        riskMetrics,
    }
}

/**
 * Get color based on risk level
 */
function getRiskColor(risk: number): string {
    if (risk < 0.25) return '#00ff00' // Green - low risk
    if (risk < 0.5) return '#ffff00' // Yellow - medium risk
    if (risk < 0.75) return '#ff8800' // Orange - high risk
    return '#ff0000' // Red - critical risk
}

/**
 * Mock data generators for when contracts are not available
 * Creates 3 nodes in upside-down triangle: Transmuter (top), LTV Disco (bottom left), Manic Loops (bottom right)
 */
export function getMockMarkets(): MarketNode[] {
    const markets: MarketNode[] = []
    const triangleRadius = 15

    // Transmuter - Top of triangle
    markets.push({
        id: 'transmuter',
        name: 'Transmuter',
        type: 'transmuter',
        position: [0, triangleRadius, 0], // Top
        size: 4,
        tvl: 2000000,
        risk: 0.3,
        color: '#ff00ff', // Magenta
        glowIntensity: 0.5,
        recentActivity: 0.4,
        metadata: {
            usdcBalance: 1500000, // Mock USDC balance
        },
    })

    // LTV Disco - Bottom left
    markets.push({
        id: 'ltv_disco',
        name: 'LTV Disco',
        type: 'disco_tranche',
        position: [
            -triangleRadius * Math.cos(Math.PI / 6),
            -triangleRadius * Math.sin(Math.PI / 6),
            0,
        ], // Bottom left
        size: 3.5,
        tvl: 5000000,
        risk: 0.4,
        color: '#8a2be2', // Purple
        glowIntensity: 0.6,
        recentActivity: 0.3,
        metadata: {
            estimatedAnnualRevenue: 250000, // Mock annual revenue
        },
    })

    // Manic Loops - Bottom right
    markets.push({
        id: 'manic_loops',
        name: 'Manic Loops',
        type: 'manic_loop',
        position: [
            triangleRadius * Math.cos(Math.PI / 6),
            -triangleRadius * Math.sin(Math.PI / 6),
            0,
        ], // Bottom right
        size: 3.5,
        tvl: 3000000,
        risk: 0.5,
        color: '#00bfff', // Cyan
        glowIntensity: 0.7,
        recentActivity: 0.5,
        metadata: {
            recentVolume: 500000, // Mock recent volume from rate limit
        },
    })

    return markets
}

export function getMockFlows(startTime: number, endTime: number): FlowEdge[] {
    const flows: FlowEdge[] = []

    // Transmuter to Manic Loops flow
    // Width based on USDC in transmuter, speed based on recent volume
    const transmuterMarket = getMockMarkets().find(m => m.id === 'transmuter')
    const manicMarket = getMockMarkets().find(m => m.id === 'manic_loops')

    if (transmuterMarket && manicMarket) {
        const usdcBalance = transmuterMarket.metadata.usdcBalance || 0
        const recentVolume = manicMarket.metadata.recentVolume || 0

        // Flow width (intensity) based on USDC balance (normalized to 0-1)
        const maxUSDC = 5000000 // Assume max USDC for normalization
        const flowIntensity = Math.min(1, usdcBalance / maxUSDC)

        // Flow speed based on recent volume (higher volume = faster)
        const maxVolume = 2000000 // Assume max volume for normalization
        const flowSpeed = Math.min(2, 0.5 + (recentVolume / maxVolume) * 1.5) // 0.5 to 2.0 speed

        flows.push({
            id: 'transmuter_to_manic',
            source: 'transmuter',
            target: 'manic_loops',
            type: 'swap',
            volume: recentVolume,
            intensity: Math.max(0.2, flowIntensity), // Minimum 0.2 for visibility
            color: '#ff00ff',
            animated: true,
            timestamp: Math.floor(Date.now() / 1000),
            metadata: {
                usdcBalance,
                recentVolume,
                flowSpeed,
            },
        })
    }

    // Manic Loops to LTV Disco flow
    // Constant animation, shows estimated annual revenue on hover
    const discoMarket = getMockMarkets().find(m => m.id === 'ltv_disco')

    if (manicMarket && discoMarket) {
        const estimatedAnnualRevenue = discoMarket.metadata.estimatedAnnualRevenue || 0

        flows.push({
            id: 'manic_to_disco',
            source: 'manic_loops',
            target: 'ltv_disco',
            type: 'revenue',
            volume: estimatedAnnualRevenue / 365, // Daily revenue
            intensity: 0.6, // Constant intensity
            color: '#8a2be2',
            animated: true,
            timestamp: Math.floor(Date.now() / 1000),
            metadata: {
                estimatedAnnualRevenue,
                flowSpeed: 0.5, // Constant speed
            },
        })
    }

    return flows
}

export function getMockEvents(startTime: number, endTime: number): SystemEvent[] {
    const events: SystemEvent[] = []
    const timeRange = endTime - startTime
    const eventTypes: SystemEvent['type'][] = [
        'cdp_open',
        'cdp_repay',
        'liquidation',
        'disco_deposit',
        'disco_withdraw',
        'transmuter_swap',
    ]
    const assets = ['atom', 'osmo', 'usdc', 'usdt']

    // Generate events throughout the time range
    const numEvents = Math.min(30, Math.floor(timeRange / 1800)) // One event per 30 min, max 30

    for (let i = 0; i < numEvents; i++) {
        const timestamp = startTime + (i * timeRange) / numEvents
        const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)]
        const asset = assets[Math.floor(Math.random() * assets.length)]
        const amount = 50000 + Math.random() * 500000

        events.push({
            id: `${eventType}_${asset}_${timestamp}`,
            type: eventType,
            marketId: `collateral_${asset}`,
            timestamp,
            magnitude: Math.min(1, amount / 1000000),
            data: {
                amount,
                asset,
                user: `user_${Math.floor(Math.random() * 100)}`,
            },
        })
    }

    return events
}

export function getMockTimelineData(startTime: number, endTime: number): TimelineData {
    const timeRange = endTime - startTime
    const numPoints = Math.min(100, Math.floor(timeRange / 3600)) // One point per hour, max 100
    const timestamps: number[] = []
    const cdtSupply: number[] = []
    const mbrnAtRisk: number[] = []
    const liquidationClusters: TimelineData['liquidationClusters'] = []
    const riskMetrics: TimelineData['riskMetrics'] = []

    const baseCDT = 5000000
    const baseMBRN = 2000000

    for (let i = 0; i < numPoints; i++) {
        const timestamp = startTime + (i * timeRange) / numPoints
        timestamps.push(timestamp)

        // Simulate gradual growth with some volatility
        const growthFactor = 1 + (i / numPoints) * 0.1
        const volatility = 0.95 + Math.random() * 0.1
        cdtSupply.push(baseCDT * growthFactor * volatility)
        mbrnAtRisk.push(baseMBRN * growthFactor * volatility)

        // Add risk metrics
        riskMetrics.push({
            timestamp,
            overallRisk: 0.3 + Math.random() * 0.2,
            marketRisks: {
                atom: 0.2 + Math.random() * 0.3,
                osmo: 0.25 + Math.random() * 0.25,
                usdc: 0.1 + Math.random() * 0.2,
            },
        })

        // Add occasional liquidation clusters
        if (Math.random() < 0.1 && i > 0) {
            liquidationClusters.push({
                timestamp,
                count: Math.floor(1 + Math.random() * 3),
                totalAmount: 100000 + Math.random() * 400000,
                positions: [`pos_${i}_1`, `pos_${i}_2`],
            })
        }
    }

    return {
        timestamps,
        cdtSupply,
        mbrnAtRisk,
        liquidationClusters,
        riskMetrics,
    }
}

