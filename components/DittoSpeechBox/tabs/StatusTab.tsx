import React, { useMemo, useState, useCallback } from 'react'
import { VStack, Box, Text, HStack, Divider } from '@chakra-ui/react'
import { DollarSign, TrendingUp, Clock, Gift, Lock, Music, Zap, ArrowRight, Link } from 'lucide-react'
import { useRouter } from 'next/router'
import { StatusCard, ShortcutCard } from '../StatusCard'
import { useProtocolUpdates } from '../hooks/useProtocolUpdates'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import { useLockdropClaimsReady } from '../hooks/useAcquisitionNotifications'
import { useVolatileWindowAlert } from '../hooks/useVolatileWindowAlert'
import { useSuggestedAction } from '../hooks/useSuggestedAction'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { RepayModal } from '@/components/NeutronMint/RepayModal'
import { generateReferralLink } from '@/helpers/referral'
import dayjs from 'dayjs'
import duration from 'dayjs/plugin/duration'

dayjs.extend(duration)

/**
 * Format duration in human-readable format
 */
const formatDuration = (ms: number): string => {
    const dur = dayjs.duration(ms)
    const hours = Math.floor(dur.asHours())
    const minutes = dur.minutes()

    if (hours > 24) {
        const days = Math.floor(hours / 24)
        return `${days}d ${hours % 24}h`
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
}

/**
 * Format MBRN value with proper truncation
 */
const formatMBRN = (amount: number): string => {
    if (amount >= 1_000_000) {
        return `${(amount / 1_000_000).toFixed(2)}M`
    } else if (amount >= 1_000) {
        return `${(amount / 1_000).toFixed(2)}K`
    }
    return amount.toFixed(2)
}

export const StatusTab: React.FC = () => {
    const router = useRouter()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { idleGains, categorizedUpdates } = useProtocolUpdates()
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()
    const { pendingClaims } = useDiscoUserMetrics(address || undefined)
    const { showAlert: showVolatileAlert, volatileAssets, pointsAvailable } = useVolatileWindowAlert()
    const { executeSuggestedAction, validatedActions, hasValidActions } = useSuggestedAction()
    const [isRepayModalOpen, setIsRepayModalOpen] = useState(false)
    const [referralCopied, setReferralCopied] = useState(false)

    const handleCopyReferral = useCallback(async () => {
        if (!address) return
        const link = generateReferralLink(address)
        await navigator.clipboard.writeText(link)
        setReferralCopied(true)
        setTimeout(() => setReferralCopied(false), 2000)
    }, [address])

    const referralTitle = referralCopied ? 'Copied!' : 'Copy Referral Link'
    const referralSubtitle = address
        ? 'Earn MBRN as referrals utilize the CDP, Transmuter, or Insurance vaults'
        : 'Connect wallet to generate your referral link'

    // Calculate pending CDT from Disco
    const pendingCDT = useMemo(() => {
        if (!pendingClaims || pendingClaims.length === 0) return 0
        return pendingClaims.reduce((sum: number, claim: any) => {
            const value = shiftDigits(claim.pending_amount || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0)
    }, [pendingClaims])

    // Navigation helpers
    const navigateTo = (path: string) => {
        router.push(`/${chainName}${path}`)
    }

    // Check for any "while you were away" data
    const hasIdleGains = idleGains && idleGains.revenueAccumulated > 0

    // Check for lockdrop claims
    const hasLockdropClaims = claimsReady && claimableAmount > 0

    // Check for pending CDT claims
    const hasPendingCDT = pendingCDT > 0.01

    // Get recent updates for display
    const recentUpdates = useMemo(() => {
        const allUpdates = [
            ...categorizedUpdates.lockdropClaimsReady,
            ...categorizedUpdates.lockdropEnding,
            ...categorizedUpdates.intentFulfilled,
        ].filter(u => !u.read).slice(0, 3)
        return allUpdates
    }, [categorizedUpdates])

    return (
        <VStack spacing={3} align="stretch" p={3} h="100%" overflowY="auto">
            {/* While You Were Away Section */}
            {hasIdleGains && (
                <Box>
                    <Text fontSize="xs" color="#ece6d880" fontWeight="medium" mb={2} textTransform="uppercase" letterSpacing="wide">
                        While You Were Away
                    </Text>
                    <StatusCard
                        icon={TrendingUp}
                        iconColor="green.400"
                        title="Revenue accumulated"
                        subtitle={`$${idleGains.revenueAccumulated.toFixed(2)} over ${formatDuration(idleGains.timeElapsed)}`}
                        subtitleHighlight={`$${idleGains.revenueAccumulated.toFixed(2)}`}
                        highlightColor="green.400"
                        onClick={() => navigateTo('/portfolio')}
                    />
                    {idleGains.mbrnEarned > 0 && (
                        <Box mt={2}>
                            <StatusCard
                                icon={Gift}
                                iconColor="primary.400"
                                title="Points earned"
                                subtitle={`+${idleGains.pointsEarned.toFixed(1)} points (${formatMBRN(idleGains.mbrnEarned)} MBRN)`}
                                subtitleHighlight={`+${idleGains.pointsEarned.toFixed(1)}`}
                                highlightColor="primary.400"
                                showChevron={false}
                            />
                        </Box>
                    )}
                </Box>
            )}

            {/* Actionable Status Cards */}
            {(hasPendingCDT || hasLockdropClaims || hasValidActions) && (
                <Box>
                    <Text fontSize="xs" color="#ece6d880" fontWeight="medium" mb={2} textTransform="uppercase" letterSpacing="wide">
                        Actions Available
                    </Text>

                    {hasPendingCDT && (
                        <StatusCard
                            icon={DollarSign}
                            iconColor="secondary.400"
                            title="Claim available"
                            subtitle={`${pendingCDT.toFixed(2)} CDT ready to claim.`}
                            subtitleHighlight={`${pendingCDT.toFixed(2)} CDT`}
                            highlightColor="secondary.400"
                            onClick={() => navigateTo('/disco')}
                        />
                    )}

                    {hasLockdropClaims && (
                        <Box mt={2}>
                            <StatusCard
                                icon={Lock}
                                iconColor="primary.400"
                                title="Lockdrop claim ready"
                                subtitle={`${claimableAmount.toFixed(2)} MBRN available to claim`}
                                subtitleHighlight={`${claimableAmount.toFixed(2)} MBRN`}
                                highlightColor="primary.400"
                                onClick={() => navigateTo('/transmuter')}
                            />
                        </Box>
                    )}

                    {/* Validated suggested actions from usePageActions */}
                    {validatedActions.map((action, idx) => (
                        <Box key={action.id} mt={(hasPendingCDT || hasLockdropClaims || idx > 0) ? 2 : 0}>
                            <StatusCard
                                icon={ArrowRight}
                                iconColor="primary.400"
                                title={action.label}
                                subtitle={action.description}
                                onClick={() => executeSuggestedAction(action.id)}
                            />
                        </Box>
                    ))}
                </Box>
            )}

            {/* Opportunities */}
            <Box>
                <Text fontSize="xs" color="#ece6d880" fontWeight="medium" mb={2} textTransform="uppercase" letterSpacing="wide">
                    Opportunities
                </Text>
                {showVolatileAlert && (
                    <StatusCard
                        icon={Zap}
                        iconColor="yellow.400"
                        title="Repay debt for MBRN"
                        subtitle="Management during volatility gets rewarded, repay any amount for +5 MBRN"
                        subtitleHighlight="+5 MBRN"
                        highlightColor="primary.400"
                        onClick={() => setIsRepayModalOpen(true)}
                    />
                )}
                <Box mt={showVolatileAlert ? 2 : 0}>
                    <StatusCard
                        icon={Link}
                        iconColor="primary.400"
                        title={referralTitle}
                        subtitle={referralSubtitle}
                        showChevron={false}
                        onClick={address ? handleCopyReferral : undefined}
                    />
                </Box>
            </Box>

            {/* Protocol Updates */}
            {recentUpdates.length > 0 && (
                <Box>
                    <Text fontSize="xs" color="#ece6d880" fontWeight="medium" mb={2} textTransform="uppercase" letterSpacing="wide">
                        Updates
                    </Text>
                    {recentUpdates.map((update, idx) => (
                        <Box key={update.id} mt={idx > 0 ? 2 : 0}>
                            <StatusCard
                                icon={Clock}
                                iconColor="yellow.400"
                                title={update.title}
                                subtitle={update.message}
                                showChevron={false}
                            />
                        </Box>
                    ))}
                </Box>
            )}

            {/* Quick Navigation Shortcuts */}
            <Box>
                <Text fontSize="xs" color="#ece6d880" fontWeight="medium" mb={2} textTransform="uppercase" letterSpacing="wide">
                    Quick Access
                </Text>

                <ShortcutCard
                    label="Jump to Disco"
                    highlightText="Disco"
                    highlightColor="primary.400"
                    onClick={() => navigateTo('/disco')}
                />

                <Box mt={2}>
                    <ShortcutCard
                        label="Jump to Manic"
                        highlightText="Manic"
                        highlightColor="secondary.400"
                        onClick={() => navigateTo('/manic')}
                    />
                </Box>

                <Box mt={2}>
                    <ShortcutCard
                        label="Jump to Transmuter"
                        highlightText="Transmuter"
                        highlightColor="blue.400"
                        onClick={() => navigateTo('/transmuter')}
                    />
                </Box>
            </Box>

            {/* Empty state */}
            {!hasIdleGains && !hasPendingCDT && !hasLockdropClaims && !hasValidActions && !showVolatileAlert && recentUpdates.length === 0 && (
                <Box textAlign="center" py={6}>
                    <Text fontSize="sm" color="#ece6d880">
                        No new updates
                    </Text>
                    <Text fontSize="xs" color="#ece6d840" mt={1}>
                        Check back later for protocol updates and earnings
                    </Text>
                </Box>
            )}

            {/* Repay Modal */}
            <RepayModal
                isOpen={isRepayModalOpen}
                onClose={() => setIsRepayModalOpen(false)}
            />
        </VStack>
    )
}

export default StatusTab









