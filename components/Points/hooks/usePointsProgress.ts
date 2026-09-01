import { useMemo } from 'react'
import { useUserPoints, useSoloLevel, useUserRank, usePointsMultipliers } from '@/hooks/usePoints'

// Vault address to name mapping
const VAULT_NAMES: Record<string, string> = {
    'osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l': 'Mars USDC Vault',
    'osmo17rvvd6jc9javy3ytr0cjcypxs20ru22kkhrpwx7j3ym02znuz0vqa37ffx': 'Range Bound LP',
    'osmo1vf6e300hv2qe7r5rln8deft45ewgyytjnwfrdfcv5rgzrfy0s6cswjqf9r': 'Earn Vault',
    'osmo1jw6r68y0uhfmqagc7uhtdddctc7wq95pncvrqnvtd47w4hx46p7se9nju5': 'Auto Stability Pool',
}

// Progress milestones (1-9); constant reference so consumers don't churn on identity.
const POINTS_MILESTONES = [1, 2, 3, 4, 5, 6, 7, 8, 9]

export interface ConversionRateRange {
    min: number
    max: number
}

export interface ConversionRate {
    label: string
    value: number
}

// Mock multipliers data for testing/fallback
const mockMultipliers = {
    interest_rate: '2.5',
    liquidation_execution: '3.0',
    liquidation_claims: '1.5',
    governance_votes: '2.0',
    transmuter_swap_fees: '1.8',
    disco_revenue: '2.2',
    vault_yields: [] as { vault_address: string; multiplier: string }[],
}

export const usePointsProgress = () => {
    const { data: pointsData } = useUserPoints()
    const { data: multipliersData } = usePointsMultipliers()
    const { data: levelData } = useSoloLevel()
    const { data: rank } = useUserRank()
    // console.log("post query", pointsData, multipliersData, levelData, rank)


    // Mock value for testing
    const totalPoints = 8
    // const totalPoints = parseFloat(pointsData?.stats?.total_points || '0')

    const { level, points_in_level, levelup_max_points } = useMemo(() => {
        return levelData || {
            level: 1,
            points_in_level: 0,
            levelup_max_points: 1,
        }
    }, [levelData])

    // Calculate conversion rate range from multipliers
    const conversionRateRange = useMemo(() => {
        // TODO(evm-migration): usePointsMultipliers is a null-stub (multipliers applied on-chain at award time) — mock fallback renders
        const multipliers = (multipliersData as any)?.points_multipliers || mockMultipliers

        const rates = [
            parseFloat(multipliers.interest_rate || '0'),
            parseFloat(multipliers.liquidation_execution || '0'),
            parseFloat(multipliers.liquidation_claims || '0'),
            parseFloat(multipliers.governance_votes || '0'),
            parseFloat(multipliers.transmuter_swap_fees || '0'),
            parseFloat(multipliers.disco_revenue || '0'),
            ...(multipliers.vault_yields || []).map((v: any) => parseFloat(v.multiplier || '0')),
        ].filter(r => r > 0)

        if (rates.length === 0) return null

        const min = Math.min(...rates)
        const max = Math.max(...rates)
        return { min, max }
    }, [multipliersData])

    // Progress milestones: 1-9, then 20 (shown as vertical line).
    // Hoisted to module scope (POINTS_MILESTONES) — a constant array needs no useMemo.
    const milestones = POINTS_MILESTONES

    const maxMilestone = 20

    // Calculate progress based on total points relative to max milestone (20)
    const progressPercentage = (totalPoints / maxMilestone) * 100

    // Tooltip content for conversion rates
    const conversionRatesTooltip = useMemo(() => {
        // TODO(evm-migration): usePointsMultipliers is a null-stub (multipliers applied on-chain at award time) — mock fallback renders
        const multipliers = (multipliersData as any)?.points_multipliers || mockMultipliers

        const rates = [
            { label: 'Interest Rate', value: parseFloat(multipliers.interest_rate || '0') },
            { label: 'Liquidation Execution', value: parseFloat(multipliers.liquidation_execution || '0') },
            { label: 'Liquidation Claims', value: parseFloat(multipliers.liquidation_claims || '0') },
            { label: 'Governance Votes', value: parseFloat(multipliers.governance_votes || '0') },
            { label: 'Transmuter Swap Fees', value: parseFloat(multipliers.transmuter_swap_fees || '0') },
            { label: 'Disco Revenue', value: parseFloat(multipliers.disco_revenue || '0') },
            ...(multipliers.vault_yields || []).map((v: any) => ({
                label: VAULT_NAMES[v.vault_address] || `Vault ${v.vault_address?.slice(0, 8) || 'unknown'}...`,
                value: parseFloat(v.multiplier || '0'),
            })),
        ].filter(r => r.value > 0)

        return rates.length > 0 ? rates : null
    }, [multipliersData])

    return {
        totalPoints,
        level,
        conversionRateRange,
        progressPercentage,
        conversionRatesTooltip,
        rank,
    }
}
