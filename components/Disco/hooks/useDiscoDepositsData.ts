import { useState, useMemo } from 'react'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { getAssetByDenom } from '@/helpers/chain'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useDiscoDeposit from '@/components/Disco/hooks/useDiscoDeposit'
import useDiscoUnstake from '@/components/Disco/hooks/useDiscoUnstake'
import useDiscoClaim from '@/components/Disco/hooks/useDiscoClaim'
import type { UserDepositInfo, UnstakeRequest } from '../types'
import { mockUnstakeRequests } from '../mockData'

export const useDiscoDepositsData = () => {
    const { address } = useWallet()
    const { chainName } = useChainRoute()
    const { deposits, lifetimeRevenue, pendingClaims, unstakeRequests, isLoading } = useDiscoUserMetrics(address || 'mock-user')

    // Calculate total MBRN from deposits
    const totalMBRN = useMemo(() => {
        if (!deposits || deposits.length === 0) return 0
        return deposits.reduce((sum: number, deposit: any) => {
            const depositTokens = deposit.deposit_tokens || deposit.deposit?.vault_tokens || "0"
            return sum + shiftDigits(depositTokens, -6).toNumber()
        }, 0)
    }, [deposits])

    // Create deposit carousel data
    const depositCarouselData = useMemo(() => {
        if (!deposits || deposits.length === 0) return []

        const currentTime = Date.now() / 1000

        return (deposits as UserDepositInfo[]).map((deposit: UserDepositInfo, index: number) => {
            // Get asset symbol
            const denom = deposit.asset || ""
            const assetInfo = getAssetByDenom(denom, chainName)
            const assetSymbol = assetInfo?.symbol || (denom.includes('USDC') || denom.includes('498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4') ? 'USDC' : denom)

            // Get deposit amount in MBRN
            const depositTokens = deposit.deposit_tokens || deposit.deposit?.vault_tokens || "0"
            const amountValue = shiftDigits(depositTokens, -6).toNumber()

            // Match claimable by slot + deposit_id
            const matchingClaims = (pendingClaims || []).filter((claim: any) => {
                return claim.slot === deposit.slot && claim.deposit_id === deposit.deposit_id
            })

            const claimableValue = matchingClaims.reduce((sum: number, claim: any) => {
                const amount = claim.pending_amount || "0"
                return sum + shiftDigits(amount, -6).toNumber()
            }, 0)

            // Lifetime revenue
            const revenueArray = (lifetimeRevenue || [])
            const latestEntry: any = revenueArray.length > 0
                ? revenueArray[revenueArray.length - 1]
                : null
            const depositLifetimeValue = latestEntry
                ? shiftDigits(latestEntry.total_claimed || latestEntry.amount || latestEntry.revenue || "0", -6).toNumber()
                : 0

            // Calculate APR
            const depositStartTime = deposit.deposit?.start_time || deposit.deposit?.last_claimed || (currentTime - (30 * 86400))
            const daysSinceDeposit = Math.max(1, (currentTime - depositStartTime) / 86400)

            let apr = 0
            if (amountValue > 0 && depositLifetimeValue > 0 && daysSinceDeposit > 0) {
                apr = (depositLifetimeValue / amountValue) * (365 / daysSinceDeposit) * 100
            }

            // Check for pending unstake requests
            const allUnstakeRequests = (unstakeRequests && unstakeRequests.length > 0) ? unstakeRequests : mockUnstakeRequests
            const pendingUnstake = allUnstakeRequests.find((req: UnstakeRequest) =>
                req.slot === deposit.slot && req.deposit_id === deposit.deposit_id
            )

            const unstakeSecondsRemaining = pendingUnstake
                ? Math.max(0, pendingUnstake.unlock_time - currentTime)
                : 0

            const canCompleteUnstake = pendingUnstake ? unstakeSecondsRemaining <= 0 : false

            return {
                id: index,
                asset: assetSymbol,
                denom,
                amount: amountValue,
                claimable: claimableValue,
                lifetime: depositLifetimeValue,
                apr,
                slot: deposit.slot,
                depositId: deposit.deposit_id,
                startTime: deposit.deposit?.start_time || null,
                compoundClaims: deposit.deposit?.compound_claims || false,
                // Unstaking state
                pendingUnstake: pendingUnstake || null,
                unstakeSecondsRemaining,
                canCompleteUnstake,
            }
        })
    }, [deposits, lifetimeRevenue, pendingClaims, unstakeRequests, chainName])

    const [currentDepositIndex, setCurrentDepositIndex] = useState(0)
    const [showDepositForm, setShowDepositForm] = useState(false)
    const [showUnstakeForm, setShowUnstakeForm] = useState(false)
    const [showDeposits, setShowDeposits] = useState(false)
    const currentDeposit = depositCarouselData[currentDepositIndex]

    // State for transaction amounts
    const [depositAmount, setDepositAmount] = useState('')

    // Get MBRN balance for deposit form
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)

    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    // Initialize deposit hook
    const depositHook = useDiscoDeposit({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 0,
        amount: depositAmount,
        depositId: currentDeposit?.depositId,
        txSuccess: () => {
            setShowDepositForm(false)
            setDepositAmount('')
        },
    })

    // Unstake hooks (request, complete, cancel)
    const requestUnstakeHook = useDiscoUnstake({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 0,
        depositId: currentDeposit?.depositId || '',
        action: 'request',
        txSuccess: () => setShowUnstakeForm(false),
    })

    const completeUnstakeHook = useDiscoUnstake({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 0,
        depositId: currentDeposit?.depositId || '',
        action: 'complete',
        txSuccess: () => {},
    })

    const cancelUnstakeHook = useDiscoUnstake({
        asset: currentDeposit?.denom || '',
        slot: currentDeposit?.slot || 0,
        depositId: currentDeposit?.depositId || '',
        action: 'cancel',
        txSuccess: () => {},
    })

    // Claim hook (per-asset)
    const claimHook = useDiscoClaim({
        asset: currentDeposit?.denom || '',
        txSuccess: () => {},
    })

    const handleClaimAll = async () => {
        if (claimHook.action?.simulate?.data) {
            await claimHook.action.tx.mutateAsync()
        }
    }

    const handleRequestUnstake = async () => {
        if (requestUnstakeHook.action?.simulate?.data) {
            await requestUnstakeHook.action.tx.mutateAsync()
        }
    }

    const handleCompleteUnstake = async () => {
        if (completeUnstakeHook.action?.simulate?.data) {
            await completeUnstakeHook.action.tx.mutateAsync()
        }
    }

    const handleCancelUnstake = async () => {
        if (cancelUnstakeHook.action?.simulate?.data) {
            await cancelUnstakeHook.action.tx.mutateAsync()
        }
    }

    const handleDepositSubmit = async () => {
        if (!depositAmount || !depositHook.action?.simulate?.data) return
        await depositHook.action.tx.mutateAsync()
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
        isLoading,
        totalMBRN,
        depositCarouselData,
        currentDepositIndex,
        currentDeposit,
        showDepositForm,
        setShowDepositForm,
        showUnstakeForm,
        setShowUnstakeForm,
        showDeposits,
        setShowDeposits,
        depositAmount,
        setDepositAmount,
        walletBalanceMBRN,
        depositHook,
        requestUnstakeHook,
        completeUnstakeHook,
        cancelUnstakeHook,
        claimHook,
        cumulativeTotals,
        weightedAPR,
        handleClaimAll,
        handleRequestUnstake,
        handleCompleteUnstake,
        handleCancelUnstake,
        handleDepositSubmit,
        handlePrevDeposit,
        handleNextDeposit,
        handlePageClick,
    }
}

export type DiscoDepositsData = ReturnType<typeof useDiscoDepositsData>
export type DiscoDepositItem = DiscoDepositsData['depositCarouselData'][number]
