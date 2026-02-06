import React, { useMemo, useRef, useEffect, useState } from 'react'
import { Box, Stack, HStack, VStack, Text, Grid, GridItem, Button, Collapse, NumberInput, NumberInputField } from '@chakra-ui/react'
import { motion, useMotionValue, useSpring, AnimatePresence } from 'framer-motion'
import { DiscoBallMeteor } from './DiscoBallMeteor'
import { MetricsSection } from './MetricsSection'
import { HexGraphic } from './HexGraphic'
import { SectionInfoCard } from './SectionInfoCard'
import { LTVNumberLineCarousel, IndividualLTVData } from './LTVNumberLineCarousel'
import { AdvancedModeToggle } from './AdvancedModeToggle'
import { DiscoDepositsSection } from './DiscoDepositsSection'
import { EpochRevenueCard } from './EpochRevenueCard'
import { useDiscoAssets, useDailyTVL, useDiscoUserMetrics } from '@/hooks/useDiscoData'
import { useEpochCountdown, useCurrentEpochRevenue } from '@/hooks/useEpochInfo'
import { useQueries, useQuery } from '@tanstack/react-query'
import { getLTVQueue, getCumulativeRevenue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { getDiscoTotalInsurance } from '@/services/flywheel'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import useDiscoDeposit from './hooks/useDiscoDeposit'
import { usePageTutorial } from '@/components/DittoSpeechBox/hooks/usePageTutorial'
import { TutorialProvider } from '@/components/DittoSpeechBox/TutorialContext'
import { TutorialButton } from '@/components/DittoSpeechBox/TutorialButton'
import { discoTutorialConfig } from './discoTutorialConfig'
import { useDittoSpeechBox } from '@/components/DittoSpeechBox/hooks/useDittoSpeechBox'
import { useTutorialStore } from '@/components/DittoSpeechBox/hooks/useTutorialStore'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { discoContract } from '@/contracts/discoContract'
import useWallet from '@/hooks/useWallet'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'
const DARK_BG = '#0A0A0A'

// Animated Counter Component using framer-motion
const AnimatedCounter: React.FC<{ value: number; decimals?: number; prefix?: string; suffix?: string }> = ({
    value,
    decimals = 0,
    prefix = '',
    suffix = '',
}) => {
    const motionValue = useMotionValue(0)
    const spring = useSpring(motionValue, { stiffness: 50, damping: 30 })
    const [displayValue, setDisplayValue] = useState(0)

    useEffect(() => {
        motionValue.set(value)
    }, [value, motionValue])

    useEffect(() => {
        const unsubscribe = spring.on('change', (latest) => {
            setDisplayValue(latest)
        })
        return () => unsubscribe()
    }, [spring])

    const formattedValue = decimals > 0
        ? parseFloat(displayValue.toFixed(decimals)).toLocaleString()
        : Math.round(displayValue).toLocaleString()

    return (
        <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            {prefix}
            {formattedValue}
            {suffix}
        </motion.span>
    )
}

export const DiscoPage = React.memo(() => {
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { openTutorial, isOpen, currentView } = useDittoSpeechBox()
    const { address } = useWallet()

    // Tutorial system
    const tutorial = usePageTutorial(discoTutorialConfig)
    const hasAutoStartedRef = React.useRef(false)
    const hasOpenedDittoRef = React.useRef(false)

    // Auto-start tutorial on first visit and open Ditto
    // Only auto-start if tutorial hasn't been seen
    useEffect(() => {
        // Don't auto-start if already seen or already started
        if (tutorial.hasSeenTutorial || tutorial.isTutorialOpen || hasAutoStartedRef.current) {
            return
        }

        hasAutoStartedRef.current = true
        // Small delay to ensure page is rendered
        const timer = setTimeout(() => {
            tutorial.startTutorial()
        }, 1000)
        return () => clearTimeout(timer)
    }, [tutorial.hasSeenTutorial, tutorial.isTutorialOpen, tutorial.startTutorial])

    // Open Ditto to tutorial when tutorial starts (only once)
    useEffect(() => {
        if (tutorial.isTutorialOpen && !hasOpenedDittoRef.current) {
            hasOpenedDittoRef.current = true
            openTutorial()
        }
        // Reset ref when tutorial closes
        if (!tutorial.isTutorialOpen) {
            hasOpenedDittoRef.current = false
        }
    }, [tutorial.isTutorialOpen, openTutorial])

    // Auto-close tutorial when navigating away (component unmounts)
    useEffect(() => {
        return () => {
            if (tutorial.isTutorialOpen) {
                // Tutorial will be closed by the hook's cleanup, but ensure Ditto closes too
                // The tutorial hook's cleanup will handle closing isTutorialOpen
            }
        }
    }, [tutorial.isTutorialOpen])
    const { data: assets } = useDiscoAssets()
    const { data: dailyTVL } = useDailyTVL()

    // Query epoch information from revenue distributor
    const { data: epochCountdown } = useEpochCountdown()
    const { data: epochRevenue } = useCurrentEpochRevenue()

    // Get USDC asset (default for now, will be selectable in future)
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)
    const { deposits, pendingClaims, lifetimeRevenue } = useDiscoUserMetrics(undefined)

    // Calculate wallet balance in MBRN (shift by -6 for display)
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

    // Query LTV queues for all assets
    const ltvQueueQueries = useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'ltv_queue', asset, appState.rpcUrl],
            queryFn: () => getLTVQueue(client || null, asset),
            enabled: !!client && !!asset,
            staleTime: 1000 * 60 * 5,
        })),
    })

    // Calculate metrics from GLOBAL data (LTV queues), not user-specific data
    const metrics = useMemo(() => {
        // Calculate GLOBAL total deposits from LTV queues (not user deposits)
        let globalTotalDeposits = 0
        let totalWeightedLTV = 0
        let totalWeight = 0
        let activeTranches = 0

        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    // Handle Uint128 and Decimal types from CosmWasm
                    const depositTokens = slot.total_deposit_tokens
                    const depositTokensStr = typeof depositTokens === 'string'
                        ? depositTokens
                        : depositTokens?.toString() || '0'
                    const weight = parseFloat(depositTokensStr) || 0

                    // Sum up global deposits (in base units, need to shift by -6 for MBRN)
                    globalTotalDeposits += weight

                    if (weight > 0) {
                        const ltvStr = slot.ltv
                        const ltv = typeof ltvStr === 'string'
                            ? parseFloat(ltvStr)
                            : parseFloat(ltvStr?.toString() || '0')
                        totalWeightedLTV += ltv * weight
                        totalWeight += weight
                    }
                    if (slot.deposit_groups && Array.isArray(slot.deposit_groups)) {
                        activeTranches += slot.deposit_groups.length
                    }
                })
            }
        })

        // Convert global deposits from base units to MBRN (shift by -6)
        const totalDeposits = shiftDigits(globalTotalDeposits.toString(), -6).toNumber() || 0
        const averageLTV = totalWeight > 0 ? totalWeightedLTV / totalWeight : 0

        // Calculate yield rate (simplified - revenue / deposits)
        const totalRevenue = lifetimeRevenue?.reduce((sum: number, entry: any) => {
            const value = shiftDigits(entry.total_revenue || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0) || 0

        // Calculate yield range (min and max from different tranches)
        // For now, use a simplified range based on average
        const avgYield = totalDeposits > 0 ? totalRevenue / totalDeposits : 0
        const yieldMin = Math.max(0, avgYield * 0.7)
        const yieldMax = avgYield * 1.3
        const yieldRange = `${(yieldMin * 100).toFixed(2)}% - ${(yieldMax * 100).toFixed(2)}%`

        // Pending revenue (from pending claims)
        const pendingRevenue = pendingClaims?.reduce((sum: number, claim: any) => {
            const value = shiftDigits(claim.pending_amount || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0) || 0

        // Total insurance
        const totalInsuranceValue = totalInsurance
            ? parseFloat(shiftDigits(totalInsurance.toString(), -6).toString())
            : 0

        // Recent liquidations (placeholder - would need actual liquidation data)
        const recentLiquidations = 0 // TODO: Query actual liquidation events

        return {
            totalDeposits: totalDeposits || 0, // Global TVL from LTV queues
            averageLTV: averageLTV || 0,
            activeTranches: activeTranches || 0,
            yieldRange: yieldRange || '0.00% - 0.00%',
            pendingRevenue: pendingRevenue || 0,
            totalInsurance: totalInsuranceValue || 0,
            recentLiquidations: recentLiquidations || 0,
        }
    }, [ltvQueueQueries, lifetimeRevenue, pendingClaims, totalInsurance, deposits])

    // Extract individual LTV slots from LTV queues (for liquidation LTV carousel)
    const individualLTVData = useMemo(() => {
        const ltvMap = new Map<number, IndividualLTVData>()

        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    const ltvStr = slot.ltv
                    const ltv = typeof ltvStr === 'string'
                        ? parseFloat(ltvStr)
                        : parseFloat(ltvStr?.toString() || '0')

                    const depositTokens = slot.total_deposit_tokens
                    const depositTokensStr = typeof depositTokens === 'string'
                        ? depositTokens
                        : depositTokens?.toString() || '0'
                    const tvl = parseFloat(depositTokensStr) || 0

                    if (tvl > 0 && ltv >= 0.6 && ltv <= 0.9) {
                        const roundedLTV = Math.round(ltv * 100) / 100
                        const existing = ltvMap.get(roundedLTV)
                        if (existing) {
                            // Aggregate TVL if multiple slots have same LTV
                            existing.tvl += tvl
                        } else {
                            ltvMap.set(roundedLTV, {
                                ltv: roundedLTV,
                                tvl: tvl,
                                slotData: slot,
                            })
                        }
                    }
                })
            }
        })

        return Array.from(ltvMap.values())
    }, [ltvQueueQueries])

    // Extract LTV pairs (liquidation + borrow) from LTV queues
    const ltvPairData = useMemo(() => {
        const pairMap = new Map<string, IndividualLTVData>()

        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    const ltvStr = slot.ltv
                    const liquidationLTV = typeof ltvStr === 'string'
                        ? parseFloat(ltvStr)
                        : parseFloat(ltvStr?.toString() || '0')

                    if (slot.deposit_groups && Array.isArray(slot.deposit_groups)) {
                        slot.deposit_groups.forEach((group: any) => {
                            const borrowLtvStr = group.max_borrow_ltv
                            const borrowLTV = typeof borrowLtvStr === 'string'
                                ? parseFloat(borrowLtvStr)
                                : parseFloat(borrowLtvStr?.toString() || '0')

                            const depositTokens = group.total_deposit_tokens
                            const depositTokensStr = typeof depositTokens === 'string'
                                ? depositTokens
                                : depositTokens?.toString() || '0'
                            const tvl = parseFloat(depositTokensStr) || 0

                            if (tvl > 0 && liquidationLTV >= 0.6 && liquidationLTV <= 0.9) {
                                const roundedLiquidationLTV = Math.round(liquidationLTV * 100) / 100
                                const roundedBorrowLTV = Math.round(borrowLTV * 100) / 100
                                const pairKey = `${roundedLiquidationLTV}-${roundedBorrowLTV}`

                                const existing = pairMap.get(pairKey)
                                if (existing) {
                                    existing.tvl += tvl
                                } else {
                                    pairMap.set(pairKey, {
                                        ltv: roundedLiquidationLTV,
                                        borrowLTV: roundedBorrowLTV,
                                        tvl: tvl,
                                        slotData: { slot, group },
                                    })
                                }
                            }
                        })
                    }
                })
            }
        })

        return Array.from(pairMap.values())
    }, [ltvQueueQueries])

    // Create allLtvGroups for Loss Absorption Order calculation
    const allLtvGroups = useMemo(() => {
        return ltvPairData.map(p => ({
            liquidationLtv: p.ltv,
            borrowLtv: p.borrowLTV || p.ltv,
            tvl: p.tvl
        }))
    }, [ltvPairData])

    // Extract unique borrow LTV values for the borrow carousel
    const borrowLTVData = useMemo(() => {
        const borrowMap = new Map<number, IndividualLTVData>()

        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    if (slot.deposit_groups && Array.isArray(slot.deposit_groups)) {
                        slot.deposit_groups.forEach((group: any) => {
                            const borrowLtvStr = group.max_borrow_ltv
                            const borrowLTV = typeof borrowLtvStr === 'string'
                                ? parseFloat(borrowLtvStr)
                                : parseFloat(borrowLtvStr?.toString() || '0')

                            const depositTokens = group.total_deposit_tokens
                            const depositTokensStr = typeof depositTokens === 'string'
                                ? depositTokens
                                : depositTokens?.toString() || '0'
                            const tvl = parseFloat(depositTokensStr) || 0

                            if (tvl > 0 && borrowLTV >= 0.6 && borrowLTV <= 0.9) {
                                const roundedBorrowLTV = Math.round(borrowLTV * 100) / 100
                                const existing = borrowMap.get(roundedBorrowLTV)
                                if (existing) {
                                    existing.tvl += tvl
                                } else {
                                    borrowMap.set(roundedBorrowLTV, {
                                        ltv: roundedBorrowLTV,
                                        tvl: tvl,
                                        slotData: { group },
                                    })
                                }
                            }
                        })
                    }
                })
            }
        })

        return Array.from(borrowMap.values())
    }, [ltvQueueQueries])

    // State for selected LTVs - initialize to defaults: Borrow LTV = 60%, Liquidation LTV = 62%
    const [selectedBorrowLTV, setSelectedBorrowLTV] = useState<number | null>(null)
    const [selectedLiquidationLTV, setSelectedLiquidationLTV] = useState<number | null>(null)
    const [isAdvancedMode, setIsAdvancedMode] = useState(false)
    const [showMetrics, setShowMetrics] = useState(false)
    const metricsRef = useRef<HTMLDivElement>(null)

    // Scroll to metrics when opened
    useEffect(() => {
        if (showMetrics && metricsRef.current) {
            setTimeout(() => {
                metricsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 100) // Small delay to ensure DOM is updated
        }
    }, [showMetrics])

    // Initialize selected LTVs: Borrow LTV = minimum (60%), Liquidation LTV = minimum + 2% (62%)
    useEffect(() => {
        if (selectedLiquidationLTV === null && selectedBorrowLTV === null) {
            const minLTV = 0.60 // 60% minimum
            const liquidationLTV = 0.62 // 62% (minimum + 2%)

            setSelectedBorrowLTV(minLTV)
            setSelectedLiquidationLTV(liquidationLTV)
        }
    }, [selectedLiquidationLTV, selectedBorrowLTV])

    // Get selected LTV pair data (both liquidation and borrow LTV)
    const selectedLTVData = useMemo(() => {
        if (!selectedLiquidationLTV && !selectedBorrowLTV) return null

        // If both are selected, try to find pair data
        if (selectedLiquidationLTV && selectedBorrowLTV) {
            const pair = ltvPairData.find(
                p => Math.abs(p.ltv - selectedLiquidationLTV!) < 0.001 &&
                    p.borrowLTV !== undefined &&
                    Math.abs(p.borrowLTV - selectedBorrowLTV!) < 0.001
            )
            if (pair) {
                return pair
            }
        }

        // Fallback: if only one is selected, use individual LTV data
        const ltv = selectedLiquidationLTV || selectedBorrowLTV
        if (!ltv) return null

        const data = individualLTVData.find((d) => Math.abs(d.ltv - ltv) < 0.001)
        if (data) {
            return data
        }

        // Return placeholder data
        return {
            ltv: selectedLiquidationLTV || ltv,
            borrowLTV: selectedBorrowLTV || undefined,
            tvl: 0,
            apr: null,
            slotData: null,
        }
    }, [selectedBorrowLTV, selectedLiquidationLTV, individualLTVData, ltvPairData])

    // Calculate APR for selected LTV
    const selectedLTVAPR = useQuery({
        queryKey: ['disco', 'ltv_apr', selectedLTVData?.ltv, appState.rpcUrl],
        queryFn: async () => {
            if (!selectedLTVData || !client || !assets?.assets || assets.assets.length === 0) {
                return null
            }

            // If TVL is 0, return null (no APR to calculate)
            if (selectedLTVData.tvl === 0) {
                return null
            }

            try {
                // Query cumulative revenue for LTV pair if both are specified, otherwise just liquidation LTV
                const revenuePromises = (assets.assets || []).map((asset: string) =>
                    getCumulativeRevenue(
                        client,
                        asset,
                        selectedLTVData.ltv.toString(),
                        selectedLTVData.borrowLTV?.toString()
                    )
                )

                const revenueResults = await Promise.all(revenuePromises)

                // Aggregate revenue entries across all assets
                const revenueMap = new Map<number, number>() // timestamp -> total revenue

                revenueResults.forEach((entries: any) => {
                    if (entries && Array.isArray(entries)) {
                        entries.forEach((entry: any) => {
                            const timestamp = entry.timestamp || 0
                            const revenue = parseFloat(shiftDigits(entry.total_revenue || '0', -6).toString())

                            const current = revenueMap.get(timestamp) || 0
                            revenueMap.set(timestamp, current + revenue)
                        })
                    }
                })

                const sortedEntries = Array.from(revenueMap.entries())
                    .map(([timestamp, total_revenue]) => ({ timestamp, total_revenue }))
                    .sort((a, b) => a.timestamp - b.timestamp)

                if (sortedEntries.length === 0) {
                    // Fallback to global yield range estimate
                    const yieldRangeMatch = metrics.yieldRange.match(/([\d.]+)%\s*-\s*([\d.]+)%/)
                    if (yieldRangeMatch) {
                        const minYield = parseFloat(yieldRangeMatch[1])
                        const maxYield = parseFloat(yieldRangeMatch[2])
                        const avgYield = (minYield + maxYield) / 2
                        return `${avgYield.toFixed(2)}%`
                    }
                    return null
                }

                // Get latest revenue (cumulative total)
                const latestEntry = sortedEntries[sortedEntries.length - 1]
                const totalRevenue = latestEntry.total_revenue

                // Get first entry timestamp to calculate days active
                const firstEntry = sortedEntries[0]
                const currentTime = Math.floor(Date.now() / 1000)
                const daysActive = Math.max(1, (currentTime - firstEntry.timestamp) / 86400)

                // Calculate APR: (total_revenue / tvl) * (365 / days_active) * 100
                const tvlInMBRN = parseFloat(shiftDigits(selectedLTVData.tvl.toString(), -6).toString())

                if (tvlInMBRN > 0 && totalRevenue > 0 && daysActive > 0) {
                    const apr = (totalRevenue / tvlInMBRN) * (365 / daysActive) * 100
                    return `${apr.toFixed(2)}%`
                }

                return null
            } catch (error) {
                console.error('Error calculating LTV APR:', error)
                // Fallback to global yield range estimate
                const yieldRangeMatch = metrics.yieldRange.match(/([\d.]+)%\s*-\s*([\d.]+)%/)
                if (yieldRangeMatch) {
                    const minYield = parseFloat(yieldRangeMatch[1])
                    const maxYield = parseFloat(yieldRangeMatch[2])
                    const avgYield = (minYield + maxYield) / 2
                    return `${avgYield.toFixed(2)}%`
                }
                return null
            }
        },
        enabled: !!selectedLTVData && !!client && !!assets?.assets?.length,
        staleTime: 1000 * 60 * 5,
    })

    // Update selectedLTVData with APR
    const selectedLTVDataWithAPR = useMemo(() => {
        if (!selectedLTVData) return null
        return {
            ...selectedLTVData,
            apr: selectedLTVAPR.data || null,
        }
    }, [selectedLTVData, selectedLTVAPR.data])

    const svgRef = useRef<SVGSVGElement>(null)
    const [depositFormTrigger, setDepositFormTrigger] = useState(0)
    const [showDepositForm, setShowDepositForm] = useState(false)
    const [depositAmount, setDepositAmount] = useState('')

    // Deposit form hook (after selectedLTVDataWithAPR is defined)
    const depositHook = useDiscoDeposit({
        asset: assets?.assets?.[0] || '',
        maxLtv: selectedLTVDataWithAPR?.ltv?.toString() ?? '',
        maxBorrowLtv: selectedLTVDataWithAPR?.borrowLTV?.toString() ?? '',
        amount: depositAmount,
        txSuccess: () => {
            setShowDepositForm(false)
            setDepositAmount('')
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
    
    // Calculate user-specific metrics for Ditto
    const userDeposits = useMemo(() => {
        if (!deposits || deposits.length === 0) return { count: 0, totalMBRN: 0 }
        const totalMBRN = deposits.reduce((sum: number, d: any) => {
            const amount = parseFloat(shiftDigits(d.amount || '0', -6).toString())
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

    // Ditto page integration
    const ditto = useDittoPage({
        contract: discoContract,
        facts: {
            // Deposit facts
            hasDeposits: userDeposits.count > 0,
            totalMBRN: userDeposits.totalMBRN,
            depositCount: userDeposits.count,
            
            // Rewards facts
            pendingRewards: pendingRewardsAmount,
            isClaimable: pendingRewardsAmount > 0.01,
            lastClaimTime: 0, // Would need to track this
            
            // Lock facts - simplified for now
            lockDuration: 0,
            lockExpiry: 0,
            isLockExpired: false,
            canExtendLock: userDeposits.count > 0,
            
            // Boost facts - placeholder until boost system is implemented
            boostMultiplier: 1,
            maxBoostMultiplier: 3,
            boostProgress: 0,
            
            // LTV tier facts
            backedTiers: individualLTVData.length,
            totalTiers: 10, // Approximate total tiers
            tierHealth: 100, // Would need actual health calculation
            
            // Protocol facts
            protocolRevenue: metrics.pendingRevenue,
            userShare: userDeposits.totalMBRN > 0 && metrics.totalDeposits > 0 
                ? (userDeposits.totalMBRN / metrics.totalDeposits) * 100 
                : 0,
            
            // Connection facts
            isConnected: !!address,
            hasMBRNBalance: parseFloat(walletBalanceMBRN) > 0,
        },
        onShortcut: (shortcutId: string, action: string) => {
            switch (action) {
                case 'claimRewards':
                    // Would trigger claim action
                    break
                case 'extendLock':
                    // Would open lock extension modal
                    break
                case 'showTierBreakdown':
                    // Scroll to LTV carousel
                    document.querySelector('[data-section="ltv-carousel"]')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    })
                    break
                case 'openDeposit':
                    setShowDepositForm(true)
                    break
            }
        },
    })

    // Prepare tutorial context value (memoized to prevent unnecessary re-renders)
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

    return (
        <TutorialProvider value={tutorialContextValue}>
            <Box
                position="relative"
                w="100%"
                minH="100vh"
                bg={DARK_BG}
            >
                {/* Advanced Mode Toggle - Top Right */}
                <AdvancedModeToggle
                    isAdvancedMode={isAdvancedMode}
                    onToggle={setIsAdvancedMode}
                />

                {/* Tutorial Button */}
                <Box
                    position="fixed"
                    bottom={4}
                    right={4}
                    zIndex={1000}
                >
                    <TutorialButton
                        onClick={() => {
                            tutorial.resetTutorial()
                            tutorial.startTutorial()
                        }}
                        isVisible={tutorial.hasCompletedTutorial}
                    />
                </Box>
                {/* Disco Ball/Meteor - Top Left */}
                <DiscoBallMeteor />

                {/* Main Content */}
                <Stack
                    direction="column"
                    spacing={8}
                    pt="120px"
                    pb={8}
                >
                    {/* Global Metrics Header Bar */}
                    {isAdvancedMode && (
                        <Box
                            w="100%"
                            maxW="1400px"
                            mx="auto"
                            px={{ base: 4, md: 8 }}
                        >
                            {/* Global Disco Metrics */}
                            <HStack
                                spacing={{ base: 4, md: 6 }}
                                justify={{ base: 'center', md: 'space-between' }}
                                flexWrap="wrap"
                                bg="rgba(10, 10, 10, 0.6)"
                                p={4}
                                borderRadius="md"
                                border="1px solid"
                                borderColor="rgba(166, 146, 255, 0.3)"
                                boxShadow={`0 0 20px ${PRIMARY_PURPLE}20`}
                                position="relative"
                                zIndex={2}
                            >
                                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                                        Total TVL
                                    </Text>
                                    <Text
                                        fontSize={{ base: 'xl', md: '2xl' }}
                                        fontWeight="bold"
                                        color={PRIMARY_PURPLE}
                                        fontFamily="mono"
                                        textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                                    >
                                        <AnimatedCounter value={metrics.totalDeposits} /> MBRN
                                    </Text>
                                </VStack>
                                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                                        Avg. LTV
                                    </Text>
                                    <Text
                                        fontSize={{ base: 'xl', md: '2xl' }}
                                        fontWeight="bold"
                                        color={PRIMARY_PURPLE}
                                        fontFamily="mono"
                                        textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                                    >
                                        <AnimatedCounter value={metrics.averageLTV * 100} decimals={1} />%
                                    </Text>
                                </VStack>
                                <VStack spacing={0} align={{ base: 'center', md: 'flex-start' }}>
                                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                                        Yield Range
                                    </Text>
                                    <Text
                                        fontSize={{ base: 'xl', md: '2xl' }}
                                        fontWeight="bold"
                                        color="cyan.400"
                                        fontFamily="mono"
                                        textShadow="0 0 10px rgba(56, 178, 172, 0.6)"
                                    >
                                        {metrics.yieldRange}
                                    </Text>
                                </VStack>
                            </HStack>
                        </Box>
                    )}

                    {/* Hex Graphic Section */}
                    <Box
                        position="relative"
                        w="100%"
                        minH="600px"
                        display="flex"
                        flexDirection="column"
                        justifyContent="center"
                        alignItems="center"
                    >
                        {/* Hex Graphic Context */}
                        <Box
                            textAlign="center"
                            mb={6}
                            px={4}
                            w="100%"
                            display="flex"
                            flexDirection="column"
                            alignItems="center"
                        >
                            <Text
                                fontSize={{ base: 'lg', md: 'xl' }}
                                fontWeight="bold"
                                bgGradient="linear(to-r, purple.400, cyan.400)"
                                bgClip="text"
                                fontFamily="mono"
                                mb={2}
                            >
                                LTV Discovery
                            </Text>
                            <Text
                                fontSize="sm"
                                color="whiteAlpha.600"
                                fontFamily="mono"
                                maxW="600px"
                            >
                                Get paid CDT while standing on the frontline for absorbing bad debt and assisting LTV discovery. Join the layered Guardians of Solvency!
                            </Text>
                        </Box>

                        {/* Section Info Card, Hex Graphic, and LTV Number Lines */}
                        {/* Desktop Layout - Grid */}
                        {isAdvancedMode ? (
                            // Advanced Mode Layout
                            <Grid
                                templateColumns={{ base: '1fr', md: '215px 1fr 215px' }}
                                gap={6}
                                w="100%"
                                maxW="1400px"
                                px={4}
                                mb={6}
                                alignItems="flex-start"
                                display={{ base: 'none', md: 'grid' }}
                            >
                                {/* Section Info Card - Left */}
                                <GridItem display="flex" justifyContent="flex-end" alignItems="center">
                                    <Box position="relative" top="300px">
                                        <SectionInfoCard selectedLTV={selectedLTVDataWithAPR} isAdvancedMode={isAdvancedMode} allLtvGroups={allLtvGroups} externalFormTrigger={depositFormTrigger} />
                                    </Box>
                                </GridItem>

                                {/* Hex Graphic Container - Centered */}
                                <GridItem display="flex" justifyContent="center" alignItems="center">
                                    <Box
                                        position="relative"
                                        w="100%"
                                        minW="400px"
                                        minH="400px"
                                        maxW={{ base: '100%', md: '800px' }}
                                        h={{ base: '700px', md: '600px' }}
                                        mx="auto"
                                    >
                                        <svg
                                            ref={svgRef}
                                            width="100%"
                                            height="100%"
                                            viewBox="150 50 500 500"
                                            preserveAspectRatio="xMidYMid meet"
                                            style={{ filter: 'drop-shadow(0 0 20px rgba(166, 146, 255, 0.3))' }}
                                        >
                                            <defs>
                                                {/* Glow filters */}
                                                <filter id="glow">
                                                    <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                                    <feMerge>
                                                        <feMergeNode in="coloredBlur" />
                                                        <feMergeNode in="SourceGraphic" />
                                                    </feMerge>
                                                </filter>
                                            </defs>

                                            {/* Hex Graphic */}
                                            <HexGraphic
                                                ltvQueues={ltvQueueQueries}
                                                svgRef={svgRef}
                                                asset={usdcAsset}
                                            />
                                        </svg>
                                    </Box>
                                </GridItem>

                                {/* Right Side - EpochRevenueCard and LTV Carousels */}
                                <GridItem display="flex" justifyContent="flex-start" alignItems="center">
                                    <VStack spacing={4} align="stretch" position="relative" top="350px" w="100%" maxW="215px">
                                        <EpochRevenueCard selectedLTV={selectedLTVDataWithAPR} />
                                        <Box
                                            w="100%"
                                            bg="rgba(10, 10, 10, 0.8)"
                                            p={4}
                                            borderRadius="md"
                                            border="2px solid"
                                            borderColor={PRIMARY_PURPLE}
                                            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                            maxH={{ base: 'none', md: '600px' }}
                                            overflowY="auto"
                                        >
                                            <VStack spacing={4} align="stretch">
                                                <LTVNumberLineCarousel
                                                    label="Liquidation LTV"
                                                    ltvValues={individualLTVData}
                                                    selectedLTV={selectedLiquidationLTV}
                                                    currentLTV={metrics.averageLTV}
                                                    onLTVSelect={setSelectedLiquidationLTV}
                                                    otherLTV={selectedBorrowLTV}
                                                    isLiquidationLTV={true}
                                                />

                                                <LTVNumberLineCarousel
                                                    label="Borrow LTV"
                                                    ltvValues={borrowLTVData}
                                                    selectedLTV={selectedBorrowLTV}
                                                    currentLTV={metrics.averageLTV}
                                                    onLTVSelect={setSelectedBorrowLTV}
                                                    otherLTV={selectedLiquidationLTV}
                                                    isLiquidationLTV={false}
                                                />
                                            </VStack>
                                        </Box>
                                    </VStack>
                                </GridItem>
                            </Grid>
                        ) : (
                            // Simple Mode Layout
                            <>
                                <Grid
                                    templateColumns={{ base: '1fr', md: '215px 1fr 215px' }}
                                    gap={6}
                                    w="100%"
                                    maxW="1400px"
                                    marginInlineStart={isAdvancedMode ? "auto" : "none"}
                                    px={4}
                                    mb={6}
                                    alignItems="flex-start"
                                    display={{ base: 'none', md: 'grid' }}
                                >
                                    {/* Section Info Card - Left */}
                                    <GridItem display="flex" justifyContent="flex-end" alignItems="center">
                                        <Box position="relative" top="300px">
                                            <SectionInfoCard selectedLTV={selectedLTVDataWithAPR} isAdvancedMode={isAdvancedMode} allLtvGroups={allLtvGroups} externalFormTrigger={depositFormTrigger} />
                                        </Box>
                                    </GridItem>

                                    {/* Hex Graphic Container - Center */}
                                    <GridItem display="flex" justifyContent="center" alignItems="center">
                                        <Box
                                            position="relative"
                                            w="100%"
                                            minW="400px"
                                            minH="400px"
                                            maxW={{ base: '100%', md: '800px' }}
                                            h={{ base: '700px', md: '600px' }}
                                            mx="auto"
                                        >
                                            <svg
                                                ref={svgRef}
                                                width="100%"
                                                height="100%"
                                                viewBox="150 50 500 500"
                                                preserveAspectRatio="xMidYMid meet"
                                                style={{ filter: 'drop-shadow(0 0 20px rgba(166, 146, 255, 0.3))' }}
                                            >
                                                <defs>
                                                    {/* Glow filters */}
                                                    <filter id="glow">
                                                        <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                                        <feMerge>
                                                            <feMergeNode in="coloredBlur" />
                                                            <feMergeNode in="SourceGraphic" />
                                                        </feMerge>
                                                    </filter>
                                                </defs>

                                                {/* Hex Graphic */}
                                                <HexGraphic
                                                    ltvQueues={ltvQueueQueries}
                                                    svgRef={svgRef}
                                                    asset={usdcAsset}
                                                />
                                            </svg>
                                        </Box>
                                    </GridItem>

                                    {/* EpochRevenueCard - Right */}
                                    <GridItem display="flex" justifyContent="flex-start" alignItems="center">
                                        <Box position="relative" top="350px">
                                            <EpochRevenueCard selectedLTV={selectedLTVDataWithAPR} />
                                        </Box>
                                    </GridItem>
                                </Grid>
                            </>
                        )}

                        {/* Mobile Layout - Hex on top, cards below in HStack */}
                        <Box
                            display={{ base: 'block', md: 'none' }}
                            w="100%"
                            maxW="1400px"
                            px={4}
                            mb={6}
                        >
                            {/* Hex Graphic Container */}
                            <Box
                                position="relative"
                                w="100%"
                                minW="400px"
                                minH="400px"
                                maxW="100%"
                                h="700px"
                                mx="auto"
                                mb={6}
                                data-tutorial="hex-graphic"
                            >
                                <svg
                                    ref={svgRef}
                                    width="100%"
                                    height="100%"
                                    viewBox="150 50 500 500"
                                    preserveAspectRatio="xMidYMid meet"
                                    style={{ filter: 'drop-shadow(0 0 20px rgba(166, 146, 255, 0.3))' }}
                                >
                                    <defs>
                                        {/* Glow filters */}
                                        <filter id="glow">
                                            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                            <feMerge>
                                                <feMergeNode in="coloredBlur" />
                                                <feMergeNode in="SourceGraphic" />
                                            </feMerge>
                                        </filter>
                                    </defs>

                                    {/* Hex Graphic */}
                                    <HexGraphic
                                        ltvQueues={ltvQueueQueries}
                                        svgRef={svgRef}
                                        asset={usdcAsset}
                                    />
                                </svg>
                            </Box>

                            {/* Cards in HStack */}
                            {isAdvancedMode ? (
                                <HStack
                                    spacing={4}
                                    justify="space-between"
                                    align="flex-start"
                                    w="100%"
                                >
                                    {/* Section Info Card */}
                                    <Box flex={1}>
                                        <SectionInfoCard selectedLTV={selectedLTVDataWithAPR} isAdvancedMode={isAdvancedMode} allLtvGroups={allLtvGroups} externalFormTrigger={depositFormTrigger} />
                                    </Box>

                                    {/* EpochRevenueCard */}
                                    <Box flex={1}>
                                        <EpochRevenueCard selectedLTV={selectedLTVDataWithAPR} />
                                    </Box>

                                    {/* LTV Number Line Carousels - Card */}
                                    <Box
                                        flex={1}
                                        maxW="215px"
                                        bg="rgba(10, 10, 10, 0.8)"
                                        p={4}
                                        borderRadius="md"
                                        border="2px solid"
                                        borderColor={PRIMARY_PURPLE}
                                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                        maxH="600px"
                                        overflowY="auto"
                                    >
                                        <VStack spacing={4} align="stretch">
                                            <LTVNumberLineCarousel
                                                label="Liquidation LTV"
                                                ltvValues={individualLTVData}
                                                selectedLTV={selectedLiquidationLTV}
                                                currentLTV={metrics.averageLTV}
                                                onLTVSelect={setSelectedLiquidationLTV}
                                                otherLTV={selectedBorrowLTV}
                                                isLiquidationLTV={true}
                                            />

                                            <LTVNumberLineCarousel
                                                label="Borrow LTV"
                                                ltvValues={borrowLTVData}
                                                selectedLTV={selectedBorrowLTV}
                                                currentLTV={metrics.averageLTV}
                                                onLTVSelect={setSelectedBorrowLTV}
                                                otherLTV={selectedLiquidationLTV}
                                                isLiquidationLTV={false}
                                            />
                                        </VStack>
                                    </Box>
                                </HStack>
                            ) : (
                                <HStack spacing={4} justify="space-between" align="flex-start" w="100%">
                                    {/* Section Info Card */}
                                    <Box flex={1}>
                                        <SectionInfoCard selectedLTV={selectedLTVDataWithAPR} isAdvancedMode={isAdvancedMode} allLtvGroups={allLtvGroups} externalFormTrigger={depositFormTrigger} />
                                    </Box>
                                    {/* EpochRevenueCard */}
                                    <Box flex={1}>
                                        <EpochRevenueCard selectedLTV={selectedLTVDataWithAPR} />
                                    </Box>
                                </HStack>
                            )}
                        </Box>
                    </Box>

                    {/* Deposit Button/Form - Above User Stats */}
                    {selectedLTVDataWithAPR && usdcAsset && (
                        <Box
                            display="flex"
                            justifyContent="center"
                            mb={6}
                            mt={8}
                            w="100%"
                        >
                            <Box
                                as={motion.div}
                                layout
                                w="20%"
                                minW="300px"
                                transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
                            >
                                <AnimatePresence mode="wait">
                                    {!showDepositForm ? (
                                        <motion.div
                                            key="button"
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            transition={{ duration: 0.2 }}
                                        >
                                            <Button
                                                w="100%"
                                                size="md"
                                                bg={PRIMARY_PURPLE}
                                                color="white"
                                                fontFamily="mono"
                                                fontSize="sm"
                                                fontWeight="bold"
                                                _hover={{
                                                    bg: 'rgb(186, 166, 255)',
                                                    boxShadow: `0 0 15px ${PRIMARY_PURPLE}60`
                                                }}
                                                onClick={() => setShowDepositForm(true)}
                                            >
                                                Increase Defense for {usdcAsset.symbol}
                                            </Button>
                                        </motion.div>
                                    ) : (
                                        <motion.div
                                            key="form"
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            transition={{ duration: 0.2 }}
                                        >
                                            <VStack
                                                spacing={4}
                                                align="stretch"
                                                bg="rgba(10, 10, 10, 0.95)"
                                                p={4}
                                                borderRadius="md"
                                                border="2px solid"
                                                borderColor={PRIMARY_PURPLE}
                                                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                            >
                                                {/* Amount Input */}
                                                <Box>
                                                    <HStack justify="space-between" mb={2}>
                                                        <Text
                                                            fontSize="xs"
                                                            color="whiteAlpha.600"
                                                            fontFamily="mono"
                                                            letterSpacing="0.5px"
                                                        >
                                                            Amount (MBRN)
                                                        </Text>
                                                        <Text
                                                            fontSize="xs"
                                                            color={PRIMARY_PURPLE}
                                                            fontFamily="mono"
                                                            letterSpacing="0.5px"
                                                            cursor="pointer"
                                                            _hover={{
                                                                color: 'rgb(186, 166, 255)',
                                                                textDecoration: 'underline'
                                                            }}
                                                            onClick={handleMaxClick}
                                                        >
                                                            Wallet: {parseFloat(walletBalanceMBRN || '0').toLocaleString()}
                                                        </Text>
                                                    </HStack>
                                                    <NumberInput
                                                        value={depositAmount}
                                                        onChange={(valueString) => setDepositAmount(valueString)}
                                                        min={0}
                                                        max={parseFloat(walletBalanceMBRN || '0')}
                                                    >
                                                        <NumberInputField
                                                            bg="rgba(10, 10, 10, 0.8)"
                                                            border="1px solid"
                                                            borderColor={`${PRIMARY_PURPLE}40`}
                                                            color="white"
                                                            fontFamily="mono"
                                                            fontSize="sm"
                                                            _hover={{ borderColor: `${PRIMARY_PURPLE}60` }}
                                                            _focus={{
                                                                borderColor: PRIMARY_PURPLE,
                                                                boxShadow: `0 0 0 1px ${PRIMARY_PURPLE}40`
                                                            }}
                                                            placeholder="0.00"
                                                            autoFocus
                                                        />
                                                    </NumberInput>
                                                </Box>

                                                {/* Action Buttons */}
                                                <HStack spacing={2}>
                                                    <Button
                                                        flex={1}
                                                        size="sm"
                                                        variant="outline"
                                                        borderColor={`${PRIMARY_PURPLE}40`}
                                                        color="whiteAlpha.700"
                                                        fontFamily="mono"
                                                        fontSize="xs"
                                                        _hover={{
                                                            borderColor: PRIMARY_PURPLE,
                                                            color: 'white'
                                                        }}
                                                        onClick={() => {
                                                            setShowDepositForm(false)
                                                            setDepositAmount('')
                                                        }}
                                                    >
                                                        Cancel
                                                    </Button>
                                                    <Button
                                                        flex={1}
                                                        size="sm"
                                                        bg={PRIMARY_PURPLE}
                                                        color="white"
                                                        fontFamily="mono"
                                                        fontSize="xs"
                                                        fontWeight="bold"
                                                        _hover={{
                                                            bg: 'rgb(186, 166, 255)',
                                                            boxShadow: `0 0 15px ${PRIMARY_PURPLE}60`
                                                        }}
                                                        isDisabled={!depositAmount || parseFloat(depositAmount) <= 0}
                                                        isLoading={depositHook.action?.tx?.isPending}
                                                        onClick={handleDeposit}
                                                    >
                                                        Deposit
                                                    </Button>
                                                </HStack>
                                            </VStack>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </Box>
                        </Box>
                    )}

                    {/* Disco Deposits Section */}
                    <Box mt={8} mb={8}>
                        <DiscoDepositsSection />
                    </Box>

                    {/* View Dashboard Toggle */}
                    <Box display="flex" justifyContent="center" mt={8} mb={4}>
                        <Button
                            onClick={() => setShowMetrics(!showMetrics)}
                            color="white"
                            bg="transparent"
                            borderRadius="md"
                            px={4}
                            py={2}
                            w="fit-content"
                            _hover={{
                                bg: 'rgba(255, 255, 255, 0.1)',
                            }}
                            _active={{
                                bg: 'rgba(255, 255, 255, 0.15)',
                            }}
                            fontFamily="mono"
                            fontSize="sm"
                        >
                            {showMetrics ? 'Close Dashboard' : 'View Dashboard'}
                        </Button>
                    </Box>

                    {/* Metrics Section - Bottom (Section-specific) */}
                    <Collapse in={showMetrics} animateOpacity>
                        <Box ref={metricsRef}>
                            {usdcAsset && (() => {
                                // Find the LTV queue for this asset
                                const assetBase = usdcAsset.base || 'USDC'
                                const assetIndex = (assets?.assets || []).findIndex((a: string) => a === assetBase)
                                const assetQueue = assetIndex >= 0 ? ltvQueueQueries[assetIndex]?.data : null

                                return (
                                    <Box>
                                        <MetricsSection
                                            globalTotalDeposits={metrics.totalDeposits}
                                            globalTotalInsurance={metrics.totalInsurance}
                                            selectedLTVData={selectedLTVDataWithAPR}
                                            ltvChartAsset={assetBase}
                                            ltvChartAssetSymbol={usdcAsset.symbol}
                                            ltvChartQueue={assetQueue}
                                        />
                                    </Box>
                                )
                            })()}
                            {!usdcAsset && (
                                <Box data-tutorial="metrics-section">
                                    <MetricsSection
                                        globalTotalDeposits={metrics.totalDeposits}
                                        globalTotalInsurance={metrics.totalInsurance}
                                        selectedLTVData={selectedLTVDataWithAPR}
                                    />
                                </Box>
                            )}
                        </Box>
                    </Collapse>
                </Stack>
            </Box>
        </TutorialProvider>
    )
})

DiscoPage.displayName = 'DiscoPage'
