import React, { useState, useMemo } from 'react'
import { VStack, Text, Box, HStack, IconButton, Button } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { getAssetByDenom } from '@/helpers/chain'
import { useChainRoute } from '@/hooks/useChainRoute'
import { EditDiscoDepositForm } from '@/components/DittoSpeechBox/sections/EditDiscoDepositForm'
import { DiscoDepositForm } from '@/components/DittoSpeechBox/sections/DiscoDepositForm'
import { DiscoWithdrawForm } from '@/components/DittoSpeechBox/sections/DiscoWithdrawForm'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import useDiscoDeposit from '@/components/Disco/hooks/useDiscoDeposit'
import useDiscoWithdraw from '@/components/Disco/hooks/useDiscoWithdraw'
import useDiscoExtendLock from '@/components/Disco/hooks/useDiscoExtendLock'
import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

export const DiscoDepositsSection: React.FC = () => {
    const { address } = useWallet()
    const { chainName } = useChainRoute()
    const { deposits, lifetimeRevenue, pendingClaims, isLoading } = useDiscoUserMetrics(address || 'mock-user')

    // Calculate total MBRN from deposits
    const totalMBRN = useMemo(() => {
        if (!deposits || deposits.length === 0) return 0
        return deposits.reduce((sum: number, deposit: any) => {
            const vaultTokens = deposit.vault_tokens || deposit.asset?.amount || "0"
            return sum + shiftDigits(vaultTokens, -6).toNumber()
        }, 0)
    }, [deposits])

    // Create deposit carousel data with claimable, lifetime revenue, and APR
    const depositCarouselData = useMemo(() => {
        if (!deposits || deposits.length === 0) return []

        const currentTime = Date.now() / 1000

        return deposits.map((deposit, index) => {
            // Extract denom and get asset symbol
            const denom = deposit.asset?.info?.native_token?.denom || deposit.asset?.info?.token?.contract_addr || ""
            const assetInfo = getAssetByDenom(denom, chainName)
            // For mock data, default to USDC if symbol not found
            const assetSymbol = assetInfo?.symbol || (denom.includes('USDC') || denom.includes('498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4') ? 'USDC' : denom)

            // Get deposit amount in MBRN (vault_tokens is in base units, 6 decimals)
            const vaultTokens = deposit.vault_tokens || deposit.asset?.amount || "0"
            const amountValue = shiftDigits(vaultTokens, -6).toNumber() // Amount in MBRN

            // Get max_ltv and max_borrow_ltv for matching
            const maxLtv = deposit.max_ltv || deposit.ltv || "0"
            const maxBorrowLtv = deposit.max_borrow_ltv || "0"

            // Calculate lock days remaining (if deposit has lock_end_time)
            const lockEndTime = deposit.lock_end_time || deposit.locked_until || null
            const lockDaysRemaining = lockEndTime && lockEndTime > currentTime
                ? Math.max(0, Math.ceil((lockEndTime - currentTime) / 86400))
                : 0

            // Match claimable: Find claims where max_ltv and max_borrow_ltv match
            const matchingClaims = (pendingClaims || []).filter((claim: any) => {
                const claimMaxLtv = claim.max_ltv?.toString() || claim.max_ltv
                const claimMaxBorrowLtv = claim.max_borrow_ltv?.toString() || claim.max_borrow_ltv
                return claimMaxLtv === maxLtv && claimMaxBorrowLtv === maxBorrowLtv
            })

            // Sum all matching claims' pending_amount (in CDT, 6 decimals)
            const claimableValue = matchingClaims.reduce((sum: number, claim: any) => {
                const amount = claim.pending_amount || "0"
                return sum + shiftDigits(amount, -6).toNumber()
            }, 0)

            // For per-deposit lifetime, we'll use the latest entry's total_claimed
            const revenueArray = (lifetimeRevenue || [])
            const latestEntry: any = revenueArray.length > 0
                ? revenueArray[revenueArray.length - 1]
                : null
            const depositLifetimeValue = latestEntry
                ? shiftDigits(latestEntry.total_claimed || latestEntry.amount || latestEntry.revenue || "0", -6).toNumber()
                : 0

            // Calculate APR: (lifetime_revenue_cdt / deposit_amount_mbrn) * (365 / days_since_deposit) * 100
            const depositStartTime = deposit.start_time || deposit.last_claimed || (currentTime - (30 * 86400))
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
                maxLtv,
                maxBorrowLtv,
                lockDaysRemaining,
                startTime: deposit.start_time || deposit.last_claimed || null,
            }
        })
    }, [deposits, lifetimeRevenue, pendingClaims, chainName])

    const [currentDepositIndex, setCurrentDepositIndex] = useState(0)
    const [showEditForm, setShowEditForm] = useState(false)
    const [showDepositForm, setShowDepositForm] = useState(false)
    const [showWithdrawForm, setShowWithdrawForm] = useState(false)
    const [showDeposits, setShowDeposits] = useState(false)
    const currentDeposit = depositCarouselData[currentDepositIndex]

    // State for transaction amounts
    const [depositAmount, setDepositAmount] = useState('')
    const [withdrawAmount, setWithdrawAmount] = useState('')
    const [extendLockDays, setExtendLockDays] = useState(0)

    // Get MBRN balance for deposit form
    const mbrnAsset = useAssetBySymbol('MBRN', chainName)
    const mbrnBalance = useBalanceByAsset(mbrnAsset)

    // Calculate wallet balance in MBRN (shift by -6 for display)
    const walletBalanceMBRN = useMemo(() => {
        if (!mbrnBalance) return '0'
        return shiftDigits(mbrnBalance, -6).toString()
    }, [mbrnBalance])

    // Initialize transaction hooks
    const depositHook = useDiscoDeposit({
        asset: currentDeposit?.denom || '',
        maxLtv: currentDeposit?.maxLtv?.toString() ?? '',
        maxBorrowLtv: currentDeposit?.maxBorrowLtv?.toString() ?? '',
        amount: depositAmount,
        txSuccess: () => {
            setShowDepositForm(false)
            setDepositAmount('')
        },
    })

    const withdrawHook = useDiscoWithdraw({
        asset: currentDeposit?.denom || '',
        maxLtv: currentDeposit?.maxLtv?.toString() ?? '',
        maxBorrowLtv: currentDeposit?.maxBorrowLtv?.toString() ?? '',
        amount: withdrawAmount,
        txSuccess: () => {
            setShowWithdrawForm(false)
            setWithdrawAmount('')
        },
    })

    const extendLockHook = useDiscoExtendLock({
        asset: currentDeposit?.denom || '',
        maxLtv: currentDeposit?.maxLtv?.toString() ?? '',
        maxBorrowLtv: currentDeposit?.maxBorrowLtv?.toString() ?? '',
        newDuration: extendLockDays * 86400, // Convert days to seconds
        txSuccess: () => {
            setShowEditForm(false)
            setExtendLockDays(0)
        },
    })

    // Claim All hook - builds messages for all deposits with pending claims
    const discoContract = (contracts as any).ltv_disco
    const { data: claimAllMsgs } = useQuery<MsgExecuteContractEncodeObject[]>({
        queryKey: ['disco_claim_all', 'msgs', address, depositCarouselData.map(d => `${d.denom}-${d.maxLtv}-${d.maxBorrowLtv}`).join(',')],
        queryFn: () => {
            if (!address || !discoContract || discoContract === '' || depositCarouselData.length === 0) {
                return []
            }

            // Build claim messages for each deposit that has pending claims
            const msgs: MsgExecuteContractEncodeObject[] = depositCarouselData
                .filter(deposit => deposit.claimable > 0)
                .map(deposit => ({
                    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                    value: MsgExecuteContract.fromPartial({
                        sender: address,
                        contract: discoContract,
                        msg: toUtf8(JSON.stringify({
                            claim: {
                                asset: deposit.denom,
                                max_ltv: deposit.maxLtv,
                                max_borrow_ltv: deposit.maxBorrowLtv,
                            }
                        })),
                        funds: [],
                    }),
                }))

            return msgs
        },
        enabled: !!address && depositCarouselData.length > 0,
    })

    const claimAllOnSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['disco_pending_claims'] })
        queryClient.invalidateQueries({ queryKey: ['disco_user_revenue'] })
        queryClient.invalidateQueries({ queryKey: ['balances'] })
    }

    const claimAllAction = useSimulateAndBroadcast({
        msgs: claimAllMsgs ?? [],
        queryKey: ['disco_claim_all_sim', (claimAllMsgs?.toString() ?? '0')],
        enabled: !!claimAllMsgs?.length,
        onSuccess: claimAllOnSuccess,
    })

    const handleDepositCancel = () => {
        setShowDepositForm(false)
        setDepositAmount('')
    }

    const handleDepositSubmit = async (amount: string) => {
        setDepositAmount(amount)
        // Trigger transaction after state update
        setTimeout(async () => {
            if (depositHook.action?.simulate?.data) {
                await depositHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleWithdrawCancel = () => {
        setShowWithdrawForm(false)
        setWithdrawAmount('')
    }

    const handleWithdrawSubmit = async (amount: string) => {
        setWithdrawAmount(amount)
        // Trigger transaction after state update
        setTimeout(async () => {
            if (withdrawHook.action?.simulate?.data) {
                await withdrawHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleClaimAll = async () => {
        if (claimAllAction?.simulate?.data) {
            await claimAllAction.tx.mutateAsync()
        }
    }

    const handleExtendLockSubmit = async (newLiquidationLTV: any, newBorrowLTV: any, newLockDays: number) => {
        setExtendLockDays(newLockDays)
        // Trigger transaction after state update
        setTimeout(async () => {
            if (extendLockHook.action?.simulate?.data) {
                await extendLockHook.action.tx.mutateAsync()
            }
        }, 100)
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

    return (
        <Box w="100%" maxW="1400px" mx="auto" px={{ base: 4, md: 8 }}>
            <VStack spacing={6} align="stretch" w="100%">
                {/* Total MBRN Display */}
                <Box
                    bg="rgba(10, 10, 10, 0.8)"
                    p={6}
                    borderRadius="md"
                    border="2px solid"
                    borderColor={PRIMARY_PURPLE}
                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                    textAlign="center"
                >
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                        Your Total MBRN Deposits
                    </Text>
                    <Text
                        fontSize={{ base: '2xl', md: '3xl' }}
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                    >
                        {totalMBRN > 0 ? `${totalMBRN.toFixed(2)} MBRN` : '—'}
                    </Text>
                </Box>

                {depositCarouselData.length > 0 ? (
                    <>
                        {!showDeposits ? (
                            /* Default View: Centered Cumulative Totals */
                            <Box display="flex" justifyContent="center" w="100%">
                                <VStack spacing={4} align="stretch" w="100%" maxW="500px">
                                    {/* Asset at top */}
                                    <Box
                                        bg="rgba(10, 10, 10, 0.8)"
                                        p={6}
                                        borderRadius="md"
                                        border="2px solid"
                                        borderColor={PRIMARY_PURPLE}
                                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                        textAlign="center"
                                    >
                                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                                            Asset
                                        </Text>
                                        <Text
                                            fontSize="2xl"
                                            fontWeight="bold"
                                            color={PRIMARY_PURPLE}
                                            fontFamily="mono"
                                            textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                                        >
                                            {currentDeposit?.asset || '—'}
                                        </Text>
                                    </Box>

                                    {/* Cumulative Totals */}
                                    <Box
                                        bg="rgba(10, 10, 10, 0.8)"
                                        p={6}
                                        borderRadius="md"
                                        border="2px solid"
                                        borderColor={PRIMARY_PURPLE}
                                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                    >
                                        <Text
                                            fontSize="lg"
                                            fontWeight="bold"
                                            color={PRIMARY_PURPLE}
                                            fontFamily="mono"
                                            letterSpacing="1px"
                                            mb={4}
                                            textAlign="center"
                                        >
                                            Cumulative Totals
                                        </Text>
                                        <VStack spacing={4} align="stretch">
                                            <HStack justify="space-between">
                                                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                    Lifetime Earnings
                                                </Text>
                                                <Text fontSize="md" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                                    {cumulativeTotals.lifetime.toFixed(2)} CDT
                                                </Text>
                                            </HStack>
                                            <HStack justify="space-between">
                                                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                    Weighted Avg APR
                                                </Text>
                                                <Text fontSize="md" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                                    {weightedAPR.toFixed(2)}%
                                                </Text>
                                            </HStack>
                                            <HStack justify="space-between">
                                                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                    Claimable CDT
                                                </Text>
                                                <Text fontSize="md" color="green.400" fontWeight="bold" fontFamily="mono">
                                                    +{cumulativeTotals.claimable.toFixed(2)} CDT
                                                </Text>
                                            </HStack>
                                        </VStack>
                                    </Box>

                                    {/* Claim All Button */}
                                    {cumulativeTotals.claimable > 0 && (
                                        <Button
                                            w="100%"
                                            color="white"
                                            bg="transparent"
                                            border="2px solid"
                                            borderColor="green.400"
                                            boxShadow="0 0 20px rgba(72, 187, 120, 0.6)"
                                            fontFamily="mono"
                                            fontSize="sm"
                                            fontWeight="bold"
                                            py={6}
                                            _hover={{
                                                bg: 'rgba(72, 187, 120, 0.2)',
                                                boxShadow: '0 0 25px rgba(72, 187, 120, 0.8)',
                                            }}
                                            onClick={handleClaimAll}
                                            isLoading={claimAllAction?.tx?.isPending}
                                            isDisabled={!claimAllMsgs?.length || cumulativeTotals.claimable <= 0}
                                        >
                                            Claim All
                                        </Button>
                                    )}

                                    {/* See All Deposits Button */}
                                    <Button
                                        w="100%"
                                        color="white"
                                        bg="transparent"
                                        border="2px solid"
                                        borderColor={PRIMARY_PURPLE}
                                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                        fontFamily="mono"
                                        fontSize="sm"
                                        fontWeight="bold"
                                        py={6}
                                        _hover={{
                                            bg: 'rgba(166, 146, 255, 0.2)',
                                            boxShadow: `0 0 25px ${PRIMARY_PURPLE}60`,
                                        }}
                                        onClick={() => setShowDeposits(true)}
                                    >
                                        See All Deposits
                                    </Button>
                                </VStack>
                            </Box>
                        ) : (
                            /* Deposits Carousel View */
                            <Box w="100%">
                                {/* Back button */}
                                <Button
                                    mb={4}
                                    variant="ghost"
                                    color="whiteAlpha.600"
                                    fontFamily="mono"
                                    fontSize="sm"
                                    onClick={() => setShowDeposits(false)}
                                    _hover={{ color: 'white', bg: 'rgba(255, 255, 255, 0.1)' }}
                                >
                                    ← Back to Summary
                                </Button>

                                {/* Centered Deposits Carousel */}
                                <Box display="flex" justifyContent="center" w="100%">
                                    <Box w="100%" maxW="600px">
                                        <Text
                                            fontSize="lg"
                                            fontWeight="bold"
                                            color={PRIMARY_PURPLE}
                                            fontFamily="mono"
                                            letterSpacing="1px"
                                            mb={4}
                                            textAlign="center"
                                        >
                                            Deposits ({depositCarouselData.length})
                                        </Text>

                                        <Box
                                            bg="rgba(10, 10, 10, 0.8)"
                                            border="2px solid"
                                            borderColor={PRIMARY_PURPLE}
                                            borderRadius="md"
                                            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                            p={6}
                                            minH="300px"
                                        >
                                            <VStack spacing={4} align="stretch">
                                                <HStack justify="space-between">
                                                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                        Asset
                                                    </Text>
                                                    <Text fontSize="md" color={PRIMARY_PURPLE} fontWeight="bold" fontFamily="mono">
                                                        {currentDeposit?.asset || '—'}
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                        Amount
                                                    </Text>
                                                    <Text fontSize="md" color="white" fontFamily="mono">
                                                        {currentDeposit?.amount.toFixed(2) || '0.00'} MBRN
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                        Lifetime
                                                    </Text>
                                                    <Text fontSize="md" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                                        {currentDeposit?.lifetime.toFixed(2) || '0.00'} CDT
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                        Current APR
                                                    </Text>
                                                    <Text fontSize="md" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                                        {currentDeposit?.apr.toFixed(2) || '0.00'}%
                                                    </Text>
                                                </HStack>
                                                <HStack justify="space-between">
                                                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                                                        Claimable
                                                    </Text>
                                                    <Text fontSize="md" color="green.400" fontWeight="bold" fontFamily="mono">
                                                        +{currentDeposit?.claimable.toFixed(2) || '0.00'} CDT
                                                    </Text>
                                                </HStack>

                                                {/* Deposit, Edit, and Withdraw buttons */}
                                                {!showEditForm && !showDepositForm && !showWithdrawForm ? (
                                                    <>
                                                        {/* Deposit and Edit on top row */}
                                                        <HStack spacing={3} mt={4}>
                                                            <Button
                                                                flex={1}
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
                                                                Deposit
                                                            </Button>
                                                            <Button
                                                                flex={1}
                                                                size="md"
                                                                variant="outline"
                                                                borderColor={PRIMARY_PURPLE}
                                                                color={PRIMARY_PURPLE}
                                                                fontFamily="mono"
                                                                fontSize="sm"
                                                                fontWeight="bold"
                                                                _hover={{
                                                                    bg: 'rgba(166, 146, 255, 0.2)',
                                                                    borderColor: 'rgb(186, 166, 255)',
                                                                }}
                                                                onClick={() => setShowEditForm(true)}
                                                            >
                                                                Edit
                                                            </Button>
                                                        </HStack>
                                                        {/* Withdraw on bottom row */}
                                                        <Button
                                                            w="100%"
                                                            size="md"
                                                            variant="outline"
                                                            borderColor="red.400"
                                                            color="red.400"
                                                            fontFamily="mono"
                                                            fontSize="sm"
                                                            fontWeight="bold"
                                                            _hover={{
                                                                bg: 'rgba(248, 113, 113, 0.2)',
                                                                borderColor: 'red.300',
                                                            }}
                                                            onClick={() => setShowWithdrawForm(true)}
                                                        >
                                                            Withdraw
                                                        </Button>
                                                    </>
                                                ) : showDepositForm ? (
                                                    <Box mt={4}>
                                                        <DiscoDepositForm
                                                            deposit={{
                                                                asset: currentDeposit?.asset || '',
                                                                maxLtv: currentDeposit?.maxLtv,
                                                                maxBorrowLtv: currentDeposit?.maxBorrowLtv,
                                                                apr: currentDeposit?.apr,
                                                            }}
                                                            walletBalanceMBRN={walletBalanceMBRN}
                                                            onCancel={handleDepositCancel}
                                                            onSubmit={handleDepositSubmit}
                                                        />
                                                    </Box>
                                                ) : showWithdrawForm ? (
                                                    <Box mt={4}>
                                                        <DiscoWithdrawForm
                                                            deposit={{
                                                                asset: currentDeposit?.asset || '',
                                                                amount: currentDeposit?.amount || 0,
                                                                maxLtv: currentDeposit?.maxLtv,
                                                                maxBorrowLtv: currentDeposit?.maxBorrowLtv,
                                                                apr: currentDeposit?.apr,
                                                                lockDaysRemaining: currentDeposit?.lockDaysRemaining,
                                                            }}
                                                            onCancel={handleWithdrawCancel}
                                                            onSubmit={handleWithdrawSubmit}
                                                        />
                                                    </Box>
                                                ) : (
                                                    <Box mt={4}>
                                                        <EditDiscoDepositForm
                                                            deposit={{
                                                                id: currentDeposit?.id || 0,
                                                                asset: currentDeposit?.asset || '',
                                                                amount: currentDeposit?.amount || 0,
                                                                maxLtv: currentDeposit?.maxLtv,
                                                                maxBorrowLtv: currentDeposit?.maxBorrowLtv,
                                                                startTime: currentDeposit?.startTime,
                                                            }}
                                                            currentLiquidationLTV={currentDeposit?.maxLtv}
                                                            currentBorrowLTV={currentDeposit?.maxBorrowLtv}
                                                            currentLockDays={currentDeposit?.lockDaysRemaining || 0}
                                                            currentAPR={currentDeposit?.apr}
                                                            onClose={() => setShowEditForm(false)}
                                                            onSubmit={handleExtendLockSubmit}
                                                            isLoading={extendLockHook.action?.tx?.isPending}
                                                        />
                                                    </Box>
                                                )}
                                            </VStack>
                                        </Box>

                                        {/* Pagination arrows */}
                                        {depositCarouselData.length > 1 && (
                                            <HStack justify="center" spacing={4} mt={4}>
                                                <IconButton
                                                    aria-label="Previous deposit"
                                                    icon={<ChevronLeftIcon />}
                                                    size="md"
                                                    variant="ghost"
                                                    color="white"
                                                    bg="rgba(10, 10, 10, 0.8)"
                                                    border="1px solid"
                                                    borderColor={PRIMARY_PURPLE}
                                                    _hover={{
                                                        bg: 'rgba(166, 146, 255, 0.2)',
                                                        borderColor: 'rgb(186, 166, 255)',
                                                    }}
                                                    onClick={handlePrevDeposit}
                                                />

                                                {/* Pagination dots */}
                                                <HStack spacing={2}>
                                                    {depositCarouselData.map((_, index) => (
                                                        <Button
                                                            key={index}
                                                            size="xs"
                                                            minW="10px"
                                                            h="10px"
                                                            p={0}
                                                            borderRadius="full"
                                                            bg={index === currentDepositIndex ? PRIMARY_PURPLE : "rgba(255, 255, 255, 0.3)"}
                                                            _hover={{
                                                                bg: index === currentDepositIndex ? 'rgb(186, 166, 255)' : 'rgba(255, 255, 255, 0.5)',
                                                            }}
                                                            onClick={() => handlePageClick(index)}
                                                            aria-label={`Go to deposit ${index + 1}`}
                                                        />
                                                    ))}
                                                </HStack>

                                                <IconButton
                                                    aria-label="Next deposit"
                                                    icon={<ChevronRightIcon />}
                                                    size="md"
                                                    variant="ghost"
                                                    color="white"
                                                    bg="rgba(10, 10, 10, 0.8)"
                                                    border="1px solid"
                                                    borderColor={PRIMARY_PURPLE}
                                                    _hover={{
                                                        bg: 'rgba(166, 146, 255, 0.2)',
                                                        borderColor: 'rgb(186, 166, 255)',
                                                    }}
                                                    onClick={handleNextDeposit}
                                                />
                                            </HStack>
                                        )}
                                    </Box>
                                </Box>
                            </Box>
                        )}
                    </>
                ) : (
                    /* Empty State */
                    <Box
                        bg="rgba(10, 10, 10, 0.8)"
                        p={8}
                        borderRadius="md"
                        border="2px solid"
                        borderColor={PRIMARY_PURPLE}
                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                        textAlign="center"
                    >
                        <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                            {isLoading ? 'Loading deposits...' : 'No deposits found'}
                        </Text>
                    </Box>
                )}
            </VStack>
        </Box>
    )
}

