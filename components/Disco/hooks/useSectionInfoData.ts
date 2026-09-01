import { useMemo } from 'react'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useDiscoAssets } from '@/hooks/useDiscoData'
import type { SlotData } from '../types'

export interface LossAbsorptionData {
    position: number | null
    mbrnAhead: number
    hasTVL: boolean
}

export interface SectionInfoData {
    walletBalanceMBRN: string
    lossAbsorptionData: LossAbsorptionData
    revenueMultiplier: number | null
    asset: string
}

// Shared data fetching + derived metrics for SectionInfoCard.
export function useSectionInfoData(
    selectedSlot: SlotData | null,
    slotsData?: SlotData[],
): SectionInfoData {
    const { chainName } = useChainRoute()
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)
    const { data: assets } = useDiscoAssets()

    // Calculate wallet balance in MBRN
    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    // Calculate Loss Absorption Order and MBRN Defense Ahead
    const lossAbsorptionData = useMemo<LossAbsorptionData>(() => {
        if (!selectedSlot) {
            return { position: null, mbrnAhead: 0, hasTVL: false }
        }

        const hasTVL = selectedSlot.tvl > 0

        // Loss absorption position = slot number (Slot 1 = 1st loss)
        const position = selectedSlot.slot

        // MBRN Defense Ahead = sum of TVL in all slots with HIGHER LTV (riskier, absorb bad debt first)
        let mbrnAhead = 0
        if (slotsData && slotsData.length > 0) {
            mbrnAhead = slotsData
                .filter(s => s.slot > selectedSlot.slot && s.tvl > 0)
                .reduce((sum, s) => sum + s.tvl, 0)
        }

        return { position, mbrnAhead, hasTVL }
    }, [selectedSlot, slotsData])

    // Calculate revenue multiplier: slot weight / min non-zero weight
    // Base (1x) = lowest weight slot, highest multiplier = highest weight slot (typically #1)
    const revenueMultiplier = useMemo(() => {
        if (!selectedSlot?.weight || !slotsData) return null

        const nonZeroWeights = slotsData.flatMap(s => {
            if (!s.weight) return []
            const weight = parseFloat(s.weight)
            return weight > 0 ? [weight] : []
        })

        if (nonZeroWeights.length === 0) return null

        const minWeight = Math.min(...nonZeroWeights)
        const slotWeight = parseFloat(selectedSlot.weight)

        if (minWeight <= 0 || slotWeight <= 0) return null

        return slotWeight / minWeight
    }, [selectedSlot, slotsData])

    // Deposit target asset
    const asset = assets?.assets?.[0] || ''

    return { walletBalanceMBRN, lossAbsorptionData, revenueMultiplier, asset }
}
