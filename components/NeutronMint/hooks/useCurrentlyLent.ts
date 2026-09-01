import { useMemo } from 'react'
import useWallet from '@/hooks/useWallet'
import { useUserAcquisitionDeposits, useAcquisitionConfig, calculatePoints } from '@/hooks/useAcquisition'
import { useUserTransmuterDeposit, useUserTransmuterIntents } from '@/hooks/useTransmuterData'
import { useUserAcquisitionIntents } from '@/hooks/useUserAcquisitionIntents'
import { useMostProfitableSlot5 } from '@/hooks/useMostProfitableSlot5'
import { useDiscoSlots } from '@/hooks/useDiscoData'
import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getCurrentEpochRevenue, getEpochCountdown } from '@/services/revenueDistributor'
import { shiftDigits } from '@/helpers/math'
import contracts from '@/config/contracts.json'
import { mockEpochRevenue, mockEpochCountdown } from '@/components/Disco/mockData'
import { num } from '@/helpers/num'

interface IntentSlot {
    asset: string
    slot: number
    symbol: string
}

export interface DepositBoostInfo {
    amount: number
    depositTime: number
    daysElapsed: number
    progress: number // 0–1
    daysRemaining: number
    isMaxed: boolean
}

export interface CurrentlyLentData {
    totalAmount: number
    acquisitionAmount: number
    baseAmount: number
    rewardVestingMbrn: number
    vestingDaysRemaining: number
    vestingProgress: number
    mbrnApr: number
    /** Insurance APR for the global combined row (weighted average) */
    insuranceApr: number
    /** Insurance APR specific to the acquisition deposit's intent */
    acquisitionInsuranceApr: number
    /** Insurance APR specific to the base transmuter deposit's intent */
    baseInsuranceApr: number
    /** Acquisition deposit's intent slot */
    acquisitionIntentSlot: IntentSlot | null
    /** Base transmuter deposit's intent slot */
    baseIntentSlot: IntentSlot | null
    /** Combined intent slot for global row display */
    intentSlot: IntentSlot | null
    isLoading: boolean
    hasDeposits: boolean
    earliestDepositTime: number
    cliffPeriodDays: number
    /** Per-deposit retention boost progress */
    depositBoosts: DepositBoostInfo[]
}

// Mock address used when wallet not connected so mock queries still fire
const MOCK_ADDRESS = 'neutron1mockuser_currently_lent'

/** Extract deposit_via_mars_mirror intent slot from user intents response */
const extractIntentSlot = (intents: any): IntentSlot | null => {
    if (!intents?.intents) return null
    for (const intent of intents.intents) {
        if ('deposit_via_mars_mirror' in intent.intent_type) {
            const { asset, slot } = intent.intent_type.deposit_via_mars_mirror
            return { asset, slot, symbol: '' }
        }
    }
    return null
}

export const useCurrentlyLent = (): CurrentlyLentData => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    // Use real address if connected, otherwise mock address for dev testing
    const queryAddress = address || MOCK_ADDRESS

    // Data sources
    const { data: acquisitionDeposits, isLoading: acqLoading } = useUserAcquisitionDeposits(queryAddress)
    const { data: baseDeposit, isLoading: baseLoading } = useUserTransmuterDeposit(queryAddress)
    const { data: acquisitionConfig, isLoading: configLoading } = useAcquisitionConfig()

    // Separate intent queries for acquisition vs transmuter
    const { data: acquisitionIntentsRaw } = useUserAcquisitionIntents(queryAddress)
    const { data: transmuterIntentsRaw } = useUserTransmuterIntents(queryAddress)
    const { data: mostProfitableSlot5 } = useMostProfitableSlot5()

    // Determine intent slots for each deposit type
    const acquisitionIntentSlot = useMemo(() => {
        return extractIntentSlot(acquisitionIntentsRaw) || (mostProfitableSlot5
            ? { asset: mostProfitableSlot5.asset, slot: mostProfitableSlot5.slot, symbol: mostProfitableSlot5.symbol }
            : null)
    }, [acquisitionIntentsRaw, mostProfitableSlot5])

    const baseIntentSlot = useMemo(() => {
        return extractIntentSlot(transmuterIntentsRaw) || (mostProfitableSlot5
            ? { asset: mostProfitableSlot5.asset, slot: mostProfitableSlot5.slot, symbol: mostProfitableSlot5.symbol }
            : null)
    }, [transmuterIntentsRaw, mostProfitableSlot5])

    // Get slot data for each intent's asset (may be the same asset)
    const acqAsset = acquisitionIntentSlot?.asset || ''
    const baseAsset = baseIntentSlot?.asset || ''
    const { data: acqSlotData } = useDiscoSlots(acqAsset)
    const { data: baseSlotData } = useDiscoSlots(baseAsset)

    // Epoch revenue data (shared across both APR calculations)
    const discoContract = (contracts as any).ltv_disco
    const { data: discoConfig } = useQuery({
        queryKey: ['disco_config', discoContract, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !discoContract || discoContract === '') return null
            try {
                return await client.queryContractSmart(discoContract, { config: {} })
            } catch {
                return null
            }
        },
        enabled: !!client && !!discoContract && discoContract !== '',
        staleTime: 1000 * 60 * 5,
    })

    const revenueDistributorAddr = discoConfig?.revenue_distributor || (contracts as any).revenue_distributor

    const { data: epochRevenue } = useQuery({
        queryKey: ['revenue_distributor', 'current_epoch_revenue', revenueDistributorAddr, appState.rpcUrl],
        queryFn: () => getCurrentEpochRevenue(client || null, revenueDistributorAddr || ''),
        enabled: !!client && !!revenueDistributorAddr && revenueDistributorAddr !== '',
        staleTime: 1000 * 60 * 5,
    })

    const { data: epochCountdown } = useQuery({
        queryKey: ['revenue_distributor', 'epoch_countdown', revenueDistributorAddr, appState.rpcUrl],
        queryFn: () => getEpochCountdown(client || null, revenueDistributorAddr || ''),
        enabled: !!client && !!revenueDistributorAddr && revenueDistributorAddr !== '',
        staleTime: 1000 * 60 * 5,
    })

    return useMemo(() => {
        const config = acquisitionConfig?.config
        const model = acquisitionConfig?.acquisition_model
        const cliffPeriodDays = config?.cliff_period_days || 90

        // Acquisition deposits (USDC, 6 decimals)
        const deposits = (acquisitionDeposits as any)?.deposits || []
        const acquisitionAmount = deposits.reduce((sum: number, d: any) => {
            return sum + parseFloat(d.amount || '0') / 1_000_000
        }, 0)

        // Earliest deposit time for vesting calculation
        const earliestDepositTime = deposits.reduce((earliest: number, d: any) => {
            const t = d.deposit_time || 0
            return earliest === 0 ? t : Math.min(earliest, t)
        }, 0)

        const now = Math.floor(Date.now() / 1000)

        // Per-deposit retention boost progress
        const depositBoosts: DepositBoostInfo[] = deposits.map((d: any) => {
            const depositTime = d.deposit_time || 0
            const amount = parseFloat(d.amount || '0') / 1_000_000
            const elapsed = depositTime > 0 ? now - depositTime : 0
            const daysElapsed = Math.floor(elapsed / 86400)
            const totalCliff = cliffPeriodDays * 86400
            const progress = totalCliff > 0
                ? Math.min(1, Math.max(0, elapsed / totalCliff))
                : 0
            const remaining = Math.max(0, Math.ceil((cliffPeriodDays * 86400 - elapsed) / 86400))
            return {
                amount,
                depositTime,
                daysElapsed,
                progress,
                daysRemaining: remaining,
                isMaxed: progress >= 1,
            }
        })

        // Base transmuter deposit (USDC, 6 decimals)
        const baseAmount = baseDeposit
            ? parseFloat(baseDeposit.underlyingUsdc || '0') / 1_000_000
            : 0

        const totalAmount = acquisitionAmount + baseAmount

        // Vesting cliff calculation
        const cliffEndTime = earliestDepositTime > 0
            ? earliestDepositTime + cliffPeriodDays * 86400
            : 0
        const vestingDaysRemaining = cliffEndTime > now
            ? Math.ceil((cliffEndTime - now) / 86400)
            : 0
        const totalCliffSeconds = cliffPeriodDays * 86400
        const elapsedSeconds = earliestDepositTime > 0 ? now - earliestDepositTime : 0
        const vestingProgress = totalCliffSeconds > 0
            ? Math.min(1, Math.max(0, elapsedSeconds / totalCliffSeconds))
            : 0

        // MBRN reward projection
        const maxMbrn = model?.max_mbrn_emission
            ? num(model.max_mbrn_emission).div(1e6).toNumber()
            : 0

        let userPoints = 0
        deposits.forEach((d: any) => {
            const amt = parseFloat(d.amount || '0')
            const lockDays = d.intended_lock_days || 0
            userPoints += calculatePoints(amt, lockDays)
        })

        const rewardVestingMbrn = maxMbrn > 0 && userPoints > 0
            ? maxMbrn * (userPoints / (userPoints + 1_000_000_000_000))
            : 0

        // MBRN APR
        const avgLockDays = deposits.length > 0
            ? deposits.reduce((sum: number, d: any) => sum + (d.intended_lock_days || 0), 0) / deposits.length
            : 90
        const mbrnApr = acquisitionAmount > 0 && rewardVestingMbrn > 0 && avgLockDays > 0
            ? (rewardVestingMbrn / acquisitionAmount) * (365 / avgLockDays) * 100
            : 0

        // Shared epoch revenue calculation
        const useMock = !epochRevenue?.revenue || !Array.isArray(epochRevenue.revenue) || epochRevenue.revenue.length === 0
        const revenueData = useMock ? mockEpochRevenue : epochRevenue
        let totalRevenue = 0
        if (revenueData?.revenue && Array.isArray(revenueData.revenue)) {
            revenueData.revenue.forEach(([, amount]: [string, string]) => {
                totalRevenue += parseFloat(shiftDigits(amount, -6).toString())
            })
        }
        const epochData = epochCountdown || mockEpochCountdown
        const epochDuration = epochData.epoch_end - epochData.epoch_start
        const epochDays = Math.max(1, epochDuration / 86400)

        // Helper: compute insurance APR for a given intent slot + slot data
        const computeInsuranceApr = (intentSlot: IntentSlot | null, slotDataSource: any): number => {
            if (!intentSlot || !slotDataSource) return 0
            const queue = slotDataSource?.queue || slotDataSource
            const slots = queue?.slots || []
            const targetSlot = slots.find((s: any) => s.index === intentSlot.slot)
            if (!targetSlot) return 0

            const slotTvl = parseFloat(targetSlot.total_deposit_tokens || '0') / 1_000_000
            if (slotTvl <= 0 || totalRevenue <= 0) return 0

            return (totalRevenue / slotTvl) * (365 / epochDays) * 100
        }

        const acquisitionInsuranceApr = computeInsuranceApr(acquisitionIntentSlot, acqSlotData)
        const baseInsuranceApr = computeInsuranceApr(baseIntentSlot, baseSlotData)

        // Global insurance APR: weighted average of both
        const insuranceApr = totalAmount > 0
            ? (acquisitionInsuranceApr * acquisitionAmount + baseInsuranceApr * baseAmount) / totalAmount
            : 0

        return {
            totalAmount,
            acquisitionAmount,
            baseAmount,
            rewardVestingMbrn,
            vestingDaysRemaining,
            vestingProgress,
            mbrnApr,
            insuranceApr,
            acquisitionInsuranceApr,
            baseInsuranceApr,
            acquisitionIntentSlot,
            baseIntentSlot,
            intentSlot: acquisitionIntentSlot || baseIntentSlot,
            isLoading: acqLoading || baseLoading || configLoading,
            hasDeposits: totalAmount > 0,
            earliestDepositTime,
            cliffPeriodDays,
            depositBoosts,
        }
    }, [
        acquisitionDeposits, baseDeposit, acquisitionConfig,
        acquisitionIntentSlot, baseIntentSlot,
        acqSlotData, baseSlotData,
        epochRevenue, epochCountdown,
        acqLoading, baseLoading, configLoading,
    ])
}
