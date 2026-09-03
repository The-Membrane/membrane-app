import React, { useEffect, useState, useRef } from 'react'
import { VStack, HStack, Text, Box, Button, Spinner, Link, Icon, Divider } from '@chakra-ui/react'
import { m, AnimatePresence } from 'framer-motion'
import { CheckCircle, XCircle, ExternalLink, AlertTriangle, Loader2 } from 'lucide-react'
import { useDittoConfirmation } from '../hooks/useDittoConfirmation'
import { getExplorer } from '@/components/ConfirmModal/getExplorer'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { getAcknowledgement } from '@/config/dittoMessages'
import { useRouter } from 'next/router'
import LoaderWithIcon from '@/components/LoaderWithIcon'
import { useUserPoints } from '@/hooks/usePoints'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = m(Box)

/**
 * Loading View - Shown while transaction is pending
 */
const TxLoadingView: React.FC<{ isApproved: boolean }> = ({ isApproved }) => {
    // TODO(evm-migration): cosmos-kit exposed the connected `wallet` (with `.prettyName`);
    // wagmi exposes the active `connector` whose `.name` is the closest equivalent.
    const { connector } = useWallet()
    const walletName = connector?.name || 'wallet'

    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
        >
            <VStack spacing={4} align="center" py={4}>
                <LoaderWithIcon />
                <VStack spacing={1}>
                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontWeight="medium">
                        {isApproved ? 'Broadcasting transaction' : `Approve on ${walletName}`}
                    </Text>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        {isApproved
                            ? 'Waiting for confirmation...'
                            : 'Please confirm in your wallet'}
                    </Text>
                </VStack>
            </VStack>
        </MotionBox>
    )
}

/**
 * Confirm View - Shows transaction details and confirm button
 */
const TxConfirmView: React.FC<{
    children: React.ReactNode
    onConfirm: () => void
    onClose: () => void
    canConfirm: boolean
    isLoading: boolean
    error: Error | null
}> = ({ children, onConfirm, onClose, canConfirm, isLoading, error }) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
        >
            <VStack spacing={3} align="stretch">
                {/* Header */}
                <VStack spacing={1} align="stretch">
                    <Text fontSize="md" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                        Confirm Transaction
                    </Text>
                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                        Please review your transaction details.
                    </Text>
                </VStack>

                <Divider borderColor="#9bdc4f30" />

                {/* Transaction Details */}
                <Box
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderRadius={0}
                    p={3}
                    maxH="150px"
                    overflow="auto"
                >
                    {children}
                </Box>

                {/* Error Display */}
                {error && (
                    <Box
                        bg={SEMANTIC_COLORS.danger}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.danger}
                        borderRadius={0}
                        p={3}
                    >
                        <HStack spacing={2} align="flex-start">
                            <Icon as={AlertTriangle} w={4} h={4} color={SEMANTIC_COLORS.danger} mt={0.5} />
                            <Text fontSize="xs" color={SEMANTIC_COLORS.danger}>
                                {error.message || 'Transaction simulation failed'}
                            </Text>
                        </HStack>
                    </Box>
                )}

                {/* Actions */}
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        borderRadius={0}
                        fontFamily={TYPOGRAPHY.fontMono}
                        onClick={onClose}
                        transition={TRANSITIONS.colors}
                        _hover={{ ...HOVER_EFFECTS.brighten, bg: 'transparent' }}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg={SEMANTIC_COLORS.primary}
                        color={SEMANTIC_COLORS.bgPrimary}
                        borderRadius={0}
                        fontFamily={TYPOGRAPHY.fontMono}
                        isLoading={isLoading}
                        isDisabled={!canConfirm}
                        onClick={onConfirm}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                        _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
                    >
                        Confirm
                    </Button>
                </HStack>
            </VStack>
        </MotionBox>
    )
}

/**
 * Success View - Shows transaction result with hash link
 */
const TxSuccessView: React.FC<{
    txData: any
    actionType: string
    onClose: () => void
    previousPoints?: string
}> = ({ txData, actionType, onClose, previousPoints }) => {
    const { chainName } = useChainRoute()
    const { chain } = useWallet()
    const router = useRouter()
    const osmo = useAssetBySymbol('OSMO', chainName)
    const { data: pointsData } = useUserPoints()
    
    const { transactionHash, gasUsed, code } = txData || {}
    const isSuccess = code === 0

    // Get acknowledgement message
    const acknowledgementMessage = getAcknowledgement(
        actionType as any,
        router.pathname
    )

    // Calculate points earned
    const [pointsEarned, setPointsEarned] = useState<number | null>(null)
    const hasCalculatedRef = useRef(false)

    useEffect(() => {
        if (!isSuccess || hasCalculatedRef.current || !pointsData?.stats?.total_points) return
        
        // Give a small delay to allow points to update on-chain
        const timer = setTimeout(() => {
            const currentPoints = parseFloat(pointsData.stats.total_points || "0")
            const previous = previousPoints ? parseFloat(previousPoints) : currentPoints
            const earned = currentPoints - previous
            
            if (earned > 0) {
                setPointsEarned(earned)
            }
            hasCalculatedRef.current = true
        }, 2000) // 2 second delay to allow on-chain update

        return () => clearTimeout(timer)
    }, [isSuccess, pointsData, previousPoints])

    // Build explorer link
    // TODO(evm-migration): EVM block explorers expose /tx/<hash>; the base URL comes from the
    // viem Chain's blockExplorers config (config/evm/chains.ts). Was: Cosmos chain.explorers
    // priority list + celat.one neutron special-casing.
    const explorerBaseUrl = chain?.blockExplorers?.default?.url
    const txLink =
        explorerBaseUrl && transactionHash
            ? `${explorerBaseUrl.replace(/\/$/, '')}/tx/${transactionHash}`
            : undefined

    const first4 = transactionHash?.slice(0, 4) || ''
    const last4 = transactionHash?.slice(-4) || ''

    return (
        <MotionBox
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3, type: 'spring', stiffness: 300 }}
        >
            <VStack spacing={4} align="stretch">
                {/* Success Icon and Message */}
                <VStack spacing={2} align="center" py={2}>
                    <MotionBox
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 15, delay: 0.1 }}
                    >
                        <Icon
                            as={isSuccess ? CheckCircle : XCircle}
                            w={12}
                            h={12}
                            color={isSuccess ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
                        />
                    </MotionBox>
                    <Text fontSize="md" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                        {isSuccess ? 'Transaction Successful!' : 'Transaction Failed'}
                    </Text>
                    {/* Acknowledgement only on success — a "Deposit landed." line under a
                        failure header would soften the failure (Badass rule 5) */}
                    {isSuccess && (
                        <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} textAlign="center">
                            {acknowledgementMessage}
                        </Text>
                    )}
                    {/* Points Earned Display */}
                    {isSuccess && pointsEarned !== null && pointsEarned > 0 && (
                        <Box
                            bg="linear-gradient(135deg, #9bdc4f20 0%, #46d39a20 100%)"
                            border="1px solid"
                            borderColor={SEMANTIC_COLORS.primary}
                            borderRadius={0}
                            px={4}
                            py={2}
                            mt={2}
                        >
                            <HStack spacing={2} align="center">
                                <Text fontSize="xs" color={SEMANTIC_COLORS.primary}>
                                    Points Earned:
                                </Text>
                                <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.primary}>
                                    +{pointsEarned.toFixed(1)}
                                </Text>
                            </HStack>
                        </Box>
                    )}
                </VStack>

                <Divider borderColor="#9bdc4f30" />

                {/* Transaction Details */}
                <VStack spacing={2} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                            Status
                        </Text>
                        <Text
                            fontSize="xs"
                            fontWeight="bold"
                            color={isSuccess ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
                        >
                            {isSuccess ? 'Success' : 'Failed'}
                        </Text>
                    </HStack>

                    {txLink && transactionHash && (
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Transaction Hash
                            </Text>
                            <Link
                                href={txLink}
                                isExternal
                                color={SEMANTIC_COLORS.primary}
                                fontSize="xs"
                                fontWeight="medium"
                                _hover={{ color: SEMANTIC_COLORS.primary }}
                            >
                                <HStack spacing={1}>
                                    <Text>{`${first4}...${last4}`}</Text>
                                    <Icon as={ExternalLink} w={3} h={3} />
                                </HStack>
                            </Link>
                        </HStack>
                    )}

                    {gasUsed && (
                        <HStack justify="space-between">
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                Gas Used
                            </Text>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textPrimary}>
                                {shiftDigits(gasUsed.toString(), -(osmo?.decimal || 6)).toString()}
                            </Text>
                        </HStack>
                    )}
                </VStack>

                {/* Close Button */}
                <Button
                    size="sm"
                    bg={SEMANTIC_COLORS.primary}
                    color={SEMANTIC_COLORS.bgPrimary}
                    borderRadius={0}
                    fontFamily={TYPOGRAPHY.fontMono}
                    onClick={onClose}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    _focusVisible={FOCUS_STYLES.ring}
                >
                    Done
                </Button>
            </VStack>
        </MotionBox>
    )
}

/**
 * Error View - Shows error details
 */
const TxErrorView: React.FC<{
    error: Error | null
    onClose: () => void
    onRetry: () => void
}> = ({ error, onClose, onRetry }) => {
    return (
        <MotionBox
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
        >
            <VStack spacing={4} align="stretch">
                {/* Error Icon and Message */}
                <VStack spacing={2} align="center" py={2}>
                    <Icon as={XCircle} w={12} h={12} color={SEMANTIC_COLORS.danger} />
                    <Text fontSize="md" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary}>
                        Transaction Failed
                    </Text>
                    <Box
                        bg={SEMANTIC_COLORS.danger}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.danger}
                        borderRadius={0}
                        p={3}
                        w="100%"
                    >
                        <Text fontSize="xs" color={SEMANTIC_COLORS.danger} textAlign="center">
                            {error?.message || 'An error occurred while processing your transaction'}
                        </Text>
                    </Box>
                </VStack>

                {/* Actions */}
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="ghost"
                        color={SEMANTIC_COLORS.textSecondary}
                        borderRadius={0}
                        fontFamily={TYPOGRAPHY.fontMono}
                        onClick={onClose}
                        transition={TRANSITIONS.colors}
                        _hover={{ ...HOVER_EFFECTS.brighten, bg: 'transparent' }}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg={SEMANTIC_COLORS.primary}
                        color={SEMANTIC_COLORS.bgPrimary}
                        borderRadius={0}
                        fontFamily={TYPOGRAPHY.fontMono}
                        onClick={onRetry}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.dim}
                        _focus={FOCUS_STYLES.ring}
                        _focusVisible={FOCUS_STYLES.ring}
                    >
                        Retry
                    </Button>
                </HStack>
            </VStack>
        </MotionBox>
    )
}

/**
 * Main TxConfirmationSection component
 */
export const TxConfirmationSection: React.FC = () => {
    const {
        view,
        children,
        actionType,
        isLoading,
        canConfirm,
        simulateError,
        txError,
        txData,
        isApproved,
        confirmTransaction,
        closeConfirmation,
        reset,
    } = useDittoConfirmation()

    // Track points before transaction
    const { data: pointsData } = useUserPoints()
    const previousPointsRef = useRef<string | null>(null)

    // Store points when transaction starts
    useEffect(() => {
        if (view === 'loading' && pointsData?.stats?.total_points) {
            previousPointsRef.current = pointsData.stats.total_points
        }
    }, [view, pointsData])

    return (
        <Box p={2}>
            <AnimatePresence mode="wait">
                {view === 'loading' && (
                    <TxLoadingView key="loading" isApproved={isApproved} />
                )}
                {view === 'confirm' && (
                    <TxConfirmView
                        key="confirm"
                        onConfirm={confirmTransaction}
                        onClose={closeConfirmation}
                        canConfirm={canConfirm}
                        isLoading={isLoading ?? false}
                        error={simulateError}
                    >
                        {children}
                    </TxConfirmView>
                )}
                {view === 'success' && (
                    <TxSuccessView
                        key="success"
                        txData={txData}
                        actionType={actionType}
                        onClose={closeConfirmation}
                        previousPoints={previousPointsRef.current || undefined}
                    />
                )}
                {view === 'error' && (
                    <TxErrorView
                        key="error"
                        error={txError}
                        onClose={closeConfirmation}
                        onRetry={() => {
                            reset()
                            confirmTransaction()
                        }}
                    />
                )}
            </AnimatePresence>
        </Box>
    )
}

