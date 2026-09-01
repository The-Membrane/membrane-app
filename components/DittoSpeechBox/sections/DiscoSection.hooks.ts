import { useState, useMemo } from 'react'
import { useDiscoUserMetrics, useDailyTVL } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { getAssetByDenom } from '@/helpers/chain'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useDiscoDeposit from '@/components/Disco/hooks/useDiscoDeposit'
import useDiscoUnstake from '@/components/Disco/hooks/useDiscoUnstake'
import useDiscoClaim from '@/components/Disco/hooks/useDiscoClaim'
import type { UserDepositInfo } from '@/components/Disco/types'

export const useDiscoSectionData = () => {
    const { address } = useWallet()
    const { chainName } = useChainRoute()
    const { deposits, lifetimeRevenue, pendingClaims, isLoading } = useDiscoUserMetrics(address || 'mock-user')
    const { data: dailyTVL } = useDailyTVL()

    // Calculate total MBRN from deposits
    const totalMBRN = useMemo(() => {
        if (!deposits || deposits.length === 0) return 0
        return deposits.reduce((sum: number, deposit: any) => {
            const depositTokens = deposit.deposit_tokens || deposit.deposit?.vault_tokens || "0"
            return sum + shiftDigits(depositTokens, -6).toNumber()
        }, 0)
    }, [deposits])

    // Create deposit carousel data with slot-based info
    const depositCarouselData = useMemo(() => {
        if (!deposits || deposits.length === 0) return []

        const currentTime = Date.now() / 1000

        return (deposits as UserDepositInfo[]).map((deposit: any, index: number) => {
            // Extract denom and get asset symbol
            const denom = deposit.asset || ""
            const assetInfo = getAssetByDenom(denom, chainName)
            const assetSymbol = assetInfo?.symbol || (denom.includes('USDC') || denom.includes('498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4') ? 'USDC' : denom)

            // Get deposit amount in MBRN
            const depositTokens = deposit.deposit_tokens || deposit.deposit?.vault_tokens || "0"
            const amountValue = shiftDigits(depositTokens, -6).toNumber()

            // Get slot and deposit_id
            const slot = deposit.slot || 1
            const depositId = deposit.deposit_id?.toString() || index.toString()

            // Match claimable: pending claims now use slot + deposit_id
            const matchingClaims = (pendingClaims || []).filter((claim: any) => {
                return claim.slot === slot && claim.deposit_id?.toString() === depositId
            })

            const claimableValue = matchingClaims.reduce((sum: number, claim: any) => {
                const amount = claim.pending_amount || "0"
                return sum + shiftDigits(amount, -6).toNumber()
            }, 0)

            // Lifetime revenue (cumulative per asset)
            const revenueArray = (lifetimeRevenue || [])
            const latestEntry: any = revenueArray.length > 0
                ? revenueArray[revenueArray.length - 1]
                : null
            const depositLifetimeValue = latestEntry
                ? shiftDigits(latestEntry.total_claimed || latestEntry.amount || latestEntry.revenue || "0", -6).toNumber()
                : 0

            // Calculate APR
            const depositStartTime = deposit.deposit?.start_time || deposit.start_time || (currentTime - (30 * 86400))
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
                slot,
                depositId,
            }
        })
    }, [deposits, lifetimeRevenue, pendingClaims, chainName])

    const [currentDepositIndex, setCurrentDepositIndex] = useState(0)
    const [showDepositForm, setShowDepositForm] = useState(false)
    const [showUnstakeForm, setShowUnstakeForm] = useState(false)
    const currentDeposit = depositCarouselData[currentDepositIndex]

    // State for transaction amounts
    const [depositAmount, setDepositAmount] = useState('')
    const [unstakeAmount, setUnstakeAmount] = useState('')

    // Get MBRN balance for deposit form
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)

    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    // Deposit hook (slot-based)
    const depositHook = useDiscoDeposit({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 1,
        amount: depositAmount,
        depositId: currentDeposit?.depositId,
        txSuccess: () => {
            setShowDepositForm(false)
            setDepositAmount('')
        },
    })

    // Unstake hook (request unstake)
    const unstakeHook = useDiscoUnstake({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 1,
        depositId: currentDeposit?.depositId || '0',
        amount: unstakeAmount || undefined,
        action: 'request',
        txSuccess: () => {
            setShowUnstakeForm(false)
            setUnstakeAmount('')
        },
    })

    // Claim hook (per-asset)
    const firstAsset = depositCarouselData.length > 0 ? depositCarouselData[0].denom : ''
    const claimHook = useDiscoClaim({
        asset: firstAsset,
        txSuccess: () => {},
    })

    const handleDepositCancel = () => {
        setShowDepositForm(false)
        setDepositAmount('')
    }

    const handleDepositSubmit = async (amount: string) => {
        setDepositAmount(amount)
        setTimeout(async () => {
            if (depositHook.action?.simulate?.data) {
                await depositHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleUnstakeCancel = () => {
        setShowUnstakeForm(false)
        setUnstakeAmount('')
    }

    const handleUnstakeSubmit = async (amount: string) => {
        setUnstakeAmount(amount)
        setTimeout(async () => {
            if (unstakeHook.action?.simulate?.data) {
                await unstakeHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleClaimAll = async () => {
        if (claimHook.action?.simulate?.data) {
            await claimHook.action.tx.mutateAsync()
        }
    }

    const handlePrevDeposit = () => {
        setCurrentDepositIndex((prev) =>
            prev > 0 ? prev - 1 : depositCarouselData.length - 1
        )
    }

    const handleNextDeposit = () => {
        setCurrentDepositIndex((prev) =>
            prev < depositCarouselData.length - 1 ? prev + 1 : 0
        )
    }

    const handlePageClick = (index: number) => {
        setCurrentDepositIndex(index)
    }

    // Calculate cumulative totals
    const cumulativeTotals = useMemo(() => {
        return depositCarouselData.reduce((acc, deposit) => ({
            claimable: acc.claimable + deposit.claimable,
            lifetime: acc.lifetime + deposit.lifetime,
            apr: acc.apr + deposit.apr,
        }), { claimable: 0, lifetime: 0, apr: 0 })
    }, [depositCarouselData])

    // Calculate weighted average APR
    const weightedAPR = useMemo(() => {
        const totalAmount = depositCarouselData.reduce((sum, d) => sum + d.amount, 0)
        if (totalAmount === 0) return 0
        return depositCarouselData.reduce((sum, d) => sum + (d.apr * d.amount), 0) / totalAmount
    }, [depositCarouselData])

    return {
        totalMBRN,
        depositCarouselData,
        currentDepositIndex,
        currentDeposit,
        showDepositForm,
        showUnstakeForm,
        setShowDepositForm,
        setShowUnstakeForm,
        walletBalanceMBRN,
        claimHook,
        isLoading,
        cumulativeTotals,
        weightedAPR,
        handleDepositCancel,
        handleDepositSubmit,
        handleUnstakeCancel,
        handleUnstakeSubmit,
        handleClaimAll,
        handlePrevDeposit,
        handleNextDeposit,
        handlePageClick,
    }
}

export type DiscoSectionData = ReturnType<typeof useDiscoSectionData>
