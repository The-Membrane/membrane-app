import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useDiscoAssets, useDiscoSlots, useDailyTVL, useDiscoUserMetrics, useSlotWeights, useUnstakeRequests } from '@/hooks/useDiscoData'
import { useEpochCountdown, useCurrentEpochRevenue } from '@/hooks/useEpochInfo'
import { useQuery } from '@tanstack/react-query'
import { getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { getDiscoTotalInsurance } from '@/services/flywheel'
import { getAssetByDenom, getAssetLogo } from '@/helpers/chain'
import { getLogoFromSymbol } from '@/components/NeutronMint/types'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import useDiscoClaim from './useDiscoClaim'
import useDiscoDeposit from './useDiscoDeposit'
import { usePageTutorial } from '@/components/DittoSpeechBox/hooks/usePageTutorial'
import { useDittoSpeechBox } from '@/components/DittoSpeechBox/hooks/useDittoSpeechBox'
import { discoTutorialConfig } from '../discoTutorialConfig'
import useWallet from '@/hooks/useWallet'
import type { DiscoSlot, SlotData, UserDepositInfo } from '../types'
import { getSlotLabel } from '../types'

/**
 * All data fetching, derived state, effects, and handlers for DiscoPage.
 * Lifted out of the view so every rendered component stays small; the hook
 * owns hook ordering and state so subcomponents receive explicit props.
 */
// Known IBC denom fallback labels for testing
const DENOM_LABELS: Record<string, string> = {
    '498A0751': 'USDC',
    '27394FB0': 'ATOM',
    'C140AFD5': 'stATOM',
    'ED07A339': 'OSMO',
}

export const useDiscoPage = () => {
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { openTutorial } = useDittoSpeechBox()
    const { address } = useWallet()

    // Tutorial system
    const tutorial = usePageTutorial(discoTutorialConfig)
    const hasAutoStartedRef = React.useRef(false)
    const hasOpenedDittoRef = React.useRef(false)

    useEffect(() => {
        if (tutorial.hasSeenTutorial || tutorial.isTutorialOpen || hasAutoStartedRef.current) {
            return
        }
        hasAutoStartedRef.current = true
        const timer = setTimeout(() => {
            tutorial.startTutorial()
        }, 1000)
        return () => clearTimeout(timer)
    }, [tutorial.hasSeenTutorial, tutorial.isTutorialOpen, tutorial.startTutorial])

    useEffect(() => {
        if (tutorial.isTutorialOpen && !hasOpenedDittoRef.current) {
            hasOpenedDittoRef.current = true
            openTutorial()
        }
        if (!tutorial.isTutorialOpen) {
            hasOpenedDittoRef.current = false
        }
    }, [tutorial.isTutorialOpen, openTutorial])

    useEffect(() => {
        return () => {
            if (tutorial.isTutorialOpen) {
                // Tutorial hook cleanup handles this
            }
        }
    }, [tutorial.isTutorialOpen])

    const { data: assets } = useDiscoAssets()
    const { data: dailyTVL } = useDailyTVL()

    // Query epoch information
    const { data: epochCountdown } = useEpochCountdown()
    const { data: epochRevenue } = useCurrentEpochRevenue()

    // Assets
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)
    const { deposits, pendingClaims, lifetimeRevenue } = useDiscoUserMetrics(address || 'mock-user')

    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    const { data: totalInsurance } = useQuery({
        queryKey: ['disco', 'total_insurance', appState.rpcUrl],
        queryFn: () => getDiscoTotalInsurance(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5,
    })

    // Asset selection state
    const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
    const [assetMenuOpen, setAssetMenuOpen] = useState(false)
    const firstAsset = selectedAsset || assets?.assets?.[0] || ''

    // Resolve asset symbols and logos for the asset menu
    const assetList = useMemo(() => {
        if (!assets?.assets) return []
        return (assets.assets as string[]).map((denom: string) => {
            const info = getAssetByDenom(denom, chainName)
            let symbol = info?.symbol
            if (!symbol) {
                // Fallback: match known IBC prefix
                const match = Object.entries(DENOM_LABELS).find(([prefix]) => denom.includes(prefix))
                symbol = match ? match[1] : denom.slice(0, 8) + '...'
            }
            const logo = info ? getAssetLogo(info) : undefined
            const fallbackLogo = getLogoFromSymbol(symbol || '')
            return { denom, symbol, logo: logo || fallbackLogo }
        })
    }, [assets, chainName])

    // Query unstake requests for the selected asset
    const { data: unstakeData } = useUnstakeRequests(address || 'mock-user', firstAsset)

    // Query slot data for the selected asset
    const { data: assetQueueData } = useDiscoSlots(firstAsset)
    const { data: slotWeightsData } = useSlotWeights(firstAsset)

    // Build slotsData from asset queue (sorted descending by LTV — highest/riskiest first)
    const slotsData: SlotData[] = useMemo(() => {
        const slots: DiscoSlot[] = assetQueueData?.queue?.slots || []
        const weights = slotWeightsData?.weights || []

        return slots.map((slot: DiscoSlot) => {
            const ltvPct = Math.round(parseFloat(slot.max_ltv) * 100)
            const weight = weights.find((w: any) => w[0] === ltvPct || w.slot === ltvPct)

            return {
                slot: ltvPct,
                ltvLabel: getSlotLabel(ltvPct),
                tvl: parseFloat(slot.total_deposit_tokens),
                weight: weight ? (Array.isArray(weight) ? weight[1] : weight.weight) : undefined,
                badDebt: slot.bad_debt,
                vaultTokens: slot.total_vault_tokens,
            }
        })
    }, [assetQueueData, slotWeightsData])

    // Calculate global metrics
    const metrics = useMemo(() => {
        let globalTotalDeposits = 0
        slotsData.forEach(slot => {
            globalTotalDeposits += slot.tvl
        })

        const totalDeposits = shiftDigits(globalTotalDeposits.toString(), -6).toNumber() || 0

        const totalInsuranceValue = totalInsurance
            ? parseFloat(shiftDigits(totalInsurance.toString(), -6).toString())
            : 0

        const pendingRevenue = pendingClaims?.reduce((sum: number, claim: any) => {
            const value = shiftDigits(claim.pending_amount || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0) || 0

        const activeSlots = slotsData.filter(s => s.tvl > 0).length

        return {
            totalDeposits,
            totalInsurance: totalInsuranceValue,
            pendingRevenue,
            activeSlots,
        }
    }, [slotsData, totalInsurance, pendingClaims])

    // State for selected slot
    const [selectedSlot, setSelectedSlot] = useState<number | null>(null)
    const [showMetrics, setShowMetrics] = useState(false)
    const metricsRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (showMetrics && metricsRef.current) {
            const id = setTimeout(() => {
                metricsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 100)
            return () => clearTimeout(id)
        }
    }, [showMetrics])

    // Initialize selected slot to middle of range
    useEffect(() => {
        if (selectedSlot === null && slotsData.length > 0) {
            const midIdx = Math.floor(slotsData.length / 2)
            setSelectedSlot(slotsData[midIdx]?.slot ?? null)
        }
    }, [selectedSlot, slotsData])

    // Get selected slot data
    const selectedSlotData: SlotData | null = useMemo(() => {
        if (!selectedSlot) return null
        return slotsData.find(s => s.slot === selectedSlot) || null
    }, [selectedSlot, slotsData])

    // Calculate APR for selected slot
    const selectedSlotAPR = useQuery({
        queryKey: ['disco', 'slot_apr', selectedSlot, firstAsset, appState.rpcUrl],
        queryFn: async () => {
            if (!selectedSlot || !client || !firstAsset) return null

            const slotData = slotsData.find(s => s.slot === selectedSlot)
            if (!slotData || slotData.tvl === 0) return null

            try {
                const revenueEntries = await getCumulativeRevenue(client, firstAsset, selectedSlot)

                if (!revenueEntries || !Array.isArray(revenueEntries) || revenueEntries.length === 0) {
                    return null
                }

                const sortedEntries = revenueEntries
                    .map((entry: any) => ({
                        timestamp: entry.timestamp || 0,
                        total_revenue: parseFloat(shiftDigits(entry.total_revenue || '0', -6).toString())
                    }))
                    .sort((a: any, b: any) => a.timestamp - b.timestamp)

                if (sortedEntries.length === 0) return null

                const latestEntry = sortedEntries[sortedEntries.length - 1]
                const firstEntry = sortedEntries[0]
                const currentTime = Math.floor(Date.now() / 1000)
                const daysActive = Math.max(1, (currentTime - firstEntry.timestamp) / 86400)
                const totalRevenue = latestEntry.total_revenue

                const tvlInMBRN = parseFloat(shiftDigits(slotData.tvl.toString(), -6).toString())

                if (tvlInMBRN > 0 && totalRevenue > 0 && daysActive > 0) {
                    const apr = (totalRevenue / tvlInMBRN) * (365 / daysActive) * 100
                    return `${apr.toFixed(2)}%`
                }

                return null
            } catch (error) {
                console.error('Error calculating slot APR:', error)
                return null
            }
        },
        enabled: !!selectedSlot && !!client && !!firstAsset,
        staleTime: 1000 * 60 * 5,
    })

    // Merge APR into selected slot data
    const selectedSlotDataWithAPR: SlotData | null = useMemo(() => {
        if (!selectedSlotData) return null
        return {
            ...selectedSlotData,
            apr: selectedSlotAPR.data || null,
        }
    }, [selectedSlotData, selectedSlotAPR.data])

    const [depositFormTrigger, setDepositFormTrigger] = useState(0)
    const [showDepositForm, setShowDepositForm] = useState(false)
    const [depositAmount, setDepositAmount] = useState('')
    const [expandedUserSlots, setExpandedUserSlots] = useState<Set<number>>(new Set())
    const [manageSlot, setManageSlot] = useState<number | null>(null)
    const [depositModalSlot, setDepositModalSlot] = useState<number | null>(null)

    // Deposit form hook
    const depositHook = useDiscoDeposit({
        asset: firstAsset,
        slot: selectedSlot || 0,
        amount: depositAmount,
        txSuccess: () => {
            setShowDepositForm(false)
            setDepositAmount('')
        },
    })

    // Claim hook for the currently selected asset
    const claimHook = useDiscoClaim({
        asset: firstAsset,
        txSuccess: () => {
            // Claims auto-refresh via cache invalidation in the hook
        },
    })

    const handleMaxClick = () => {
        if (walletBalanceMBRN) {
            setDepositAmount(walletBalanceMBRN)
        }
    }

    const handleDeposit = async () => {
        if (!depositAmount || !depositHook.action?.simulate?.data) return
        await depositHook.action.tx.mutateAsync()
    }

    // =====================
    // DITTO INTEGRATION
    // =====================

    const userDeposits = useMemo(() => {
        if (!deposits || deposits.length === 0) return { count: 0, totalMBRN: 0 }
        const totalMBRN = deposits.reduce((sum: number, d: any) => {
            const amount = parseFloat(shiftDigits(d.deposit_tokens || d.amount || '0', -6).toString())
            return sum + amount
        }, 0)
        return { count: deposits.length, totalMBRN }
    }, [deposits])

    const pendingRewardsAmount = useMemo(() => {
        if (!pendingClaims || pendingClaims.length === 0) return 0
        return pendingClaims.reduce((sum: number, claim: any) => {
            const value = shiftDigits(claim.pending_amount || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0)
    }, [pendingClaims])

    // =====================
    // USER DEPOSIT DATA (for left column totals + right column waterfall)
    // =====================

    // Build per-deposit data
    const depositCarouselData = useMemo(() => {
        if (!deposits || deposits.length === 0) return []
        const currentTime = Date.now() / 1000
        return (deposits as UserDepositInfo[]).map((deposit: UserDepositInfo, index: number) => {
            const denom = deposit.asset || ''
            const assetInfo = getAssetByDenom(denom, chainName)
            const assetSymbol = assetInfo?.symbol || (denom.includes('USDC') || denom.includes('498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4') ? 'USDC' : denom)
            const depositTokens = deposit.deposit_tokens || deposit.deposit?.vault_tokens || '0'
            const amountValue = shiftDigits(depositTokens, -6).toNumber()
            const matchingClaims = (pendingClaims || []).filter((claim: any) =>
                claim.slot === deposit.slot && claim.deposit_id === deposit.deposit_id
            )
            const claimableValue = matchingClaims.reduce((sum: number, claim: any) =>
                sum + shiftDigits(claim.pending_amount || '0', -6).toNumber(), 0)
            const revenueArray = (lifetimeRevenue || [])
            const latestEntry: any = revenueArray.length > 0 ? revenueArray[revenueArray.length - 1] : null
            const depositLifetimeValue = latestEntry
                ? shiftDigits(latestEntry.total_claimed || latestEntry.amount || latestEntry.revenue || '0', -6).toNumber()
                : 0
            const depositStartTime = deposit.deposit?.start_time || deposit.deposit?.last_claimed || (currentTime - (30 * 86400))
            const daysSinceDeposit = Math.max(1, (currentTime - depositStartTime) / 86400)
            let apr = 0
            if (amountValue > 0 && depositLifetimeValue > 0 && daysSinceDeposit > 0) {
                apr = (depositLifetimeValue / amountValue) * (365 / daysSinceDeposit) * 100
            }
            return {
                id: index,
                asset: assetSymbol,
                denom,
                amount: amountValue,
                claimable: claimableValue,
                lifetime: depositLifetimeValue,
                apr,
                slot: deposit.slot,
            }
        })
    }, [deposits, lifetimeRevenue, pendingClaims, chainName])

    // Cumulative totals
    const cumulativeTotals = useMemo(() => {
        return depositCarouselData.reduce((acc, deposit) => ({
            claimable: acc.claimable + deposit.claimable,
            lifetime: acc.lifetime + deposit.lifetime,
            apr: acc.apr + deposit.apr,
        }), { claimable: 0, lifetime: 0, apr: 0 })
    }, [depositCarouselData])

    // Total unstaking across all slots
    const totalUnstaking = useMemo(() => {
        return (unstakeData?.requests || []).reduce((sum: number, req: any) => {
            const tokens = parseFloat(req.vault_tokens || '0')
            return sum + shiftDigits(tokens.toString(), -6).toNumber()
        }, 0)
    }, [unstakeData])

    // Weighted average APR
    const weightedAPR = useMemo(() => {
        const totalAmount = depositCarouselData.reduce((sum, d) => sum + d.amount, 0)
        if (totalAmount === 0) return 0
        return depositCarouselData.reduce((sum, d) => sum + (d.apr * d.amount), 0) / totalAmount
    }, [depositCarouselData])

    // User deposits aggregated per slot (for waterfall) — only slots with deposits
    const userSlotDeposits = useMemo(() => {
        const slotMap = new Map<number, { amount: number; claimable: number; lifetime: number; apr: number; count: number }>()
        depositCarouselData.forEach((d: any) => {
            const existing = slotMap.get(d.slot) || { amount: 0, claimable: 0, lifetime: 0, apr: 0, count: 0 }
            existing.amount += d.amount
            existing.claimable += d.claimable
            existing.lifetime += d.lifetime
            existing.apr += d.apr * d.amount // weighted for later avg
            existing.count += 1
            slotMap.set(d.slot, existing)
        })
        // Only slots with deposits, sorted descending by LTV (highest first)
        const slots = Array.from(slotMap.entries())
            .map(([slot, data]) => ({
                slot,
                amount: data.amount,
                claimable: data.claimable,
                lifetime: data.lifetime,
                apr: data.amount > 0 ? data.apr / data.amount : 0,
                count: data.count,
            }))
            .sort((a, b) => b.slot - a.slot)
        const maxAmount = Math.max(...slots.map(d => d.amount), 1)
        return { slots, maxAmount }
    }, [depositCarouselData])

    // Calculate buffer (global TVL ahead) for each user deposit slot
    const bufferData = useMemo(() => {
        const buffers = new Map<number, number>()
        userSlotDeposits.slots.forEach(({ slot }) => {
            // Sum global TVL of all slots with HIGHER LTV than this slot
            const mbrnAhead = slotsData
                .filter(s => s.slot > slot)
                .reduce((sum, s) => sum + s.tvl, 0)
            buffers.set(slot, mbrnAhead)
        })
        return buffers
    }, [userSlotDeposits.slots, slotsData])

    // Claim All handler
    const handleClaimAll = useCallback(async () => {
        if (!claimHook.action?.simulate?.data) return
        await claimHook.action.tx.mutateAsync()
    }, [claimHook.action])

    // TODO: Re-enable Ditto integration after stabilizing render cycle
    // const ditto = useDittoPage({ ... })

    const tutorialContextValue = useMemo(() => ({
        steps: tutorial.steps,
        faq: tutorial.faq,
        currentStep: tutorial.currentStep,
        isFirstStep: tutorial.isFirstStep,
        isLastStep: tutorial.isLastStep,
        totalSteps: tutorial.totalSteps,
        onNext: tutorial.nextStep,
        onPrevious: tutorial.previousStep,
        onFinish: tutorial.finishTutorial,
        onSkip: tutorial.skipTutorial,
    }), [
        tutorial.steps,
        tutorial.faq,
        tutorial.currentStep,
        tutorial.isFirstStep,
        tutorial.isLastStep,
        tutorial.totalSteps,
        tutorial.nextStep,
        tutorial.previousStep,
        tutorial.finishTutorial,
        tutorial.skipTutorial,
    ])

    return {
        tutorial,
        tutorialContextValue,
        usdcAsset,
        walletBalanceMBRN,
        setSelectedAsset,
        assetMenuOpen,
        setAssetMenuOpen,
        firstAsset,
        assetList,
        unstakeData,
        assetQueueData,
        slotsData,
        metrics,
        selectedSlot,
        setSelectedSlot,
        showMetrics,
        setShowMetrics,
        metricsRef,
        selectedSlotDataWithAPR,
        depositFormTrigger,
        depositAmount,
        setDepositAmount,
        expandedUserSlots,
        setExpandedUserSlots,
        manageSlot,
        setManageSlot,
        depositModalSlot,
        setDepositModalSlot,
        depositHook,
        claimHook,
        handleDeposit,
        userDeposits,
        depositCarouselData,
        cumulativeTotals,
        totalUnstaking,
        weightedAPR,
        userSlotDeposits,
        bufferData,
        handleClaimAll,
    }
}

export type DiscoPageState = ReturnType<typeof useDiscoPage>
