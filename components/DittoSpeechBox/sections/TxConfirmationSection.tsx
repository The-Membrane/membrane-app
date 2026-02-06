import React, { useEffect, useState, useRef } from 'react'
import { VStack, HStack, Text, Box, Button, Spinner, Link, Icon, Divider } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, XCircle, ExternalLink, AlertTriangle, Loader2 } from 'lucide-react'
import { useDittoConfirmation } from '../hooks/useDittoConfirmation'
import { getExplorer } from '@/components/ConfirmModal/ExplorerLink'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { getAcknowledgement } from '@/config/dittoMessages'
import { useRouter } from 'next/router'
import LoaderWithIcon from '@/components/LoaderWithIcon'
import { useUserPoints } from '@/hooks/usePoints'

const MotionBox = motion(Box)

/**
 * Loading View - Shown while transaction is pending
 */
const TxLoadingView: React.FC<{ isApproved: boolean }> = ({ isApproved }) => {
    const { wallet } = useWallet()
    const walletName = wallet?.prettyName || 'wallet'

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
                    <Text fontSize="sm" color="#F5F5F5" fontWeight="medium">
                        {isApproved ? 'Broadcasting transaction' : `Approve on ${walletName}`}
                    </Text>
                    <Text fontSize="xs" color="#F5F5F580">
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
                    <Text fontSize="md" fontWeight="bold" color="#F5F5F5">
                        Confirm Transaction
                    </Text>
                    <Text fontSize="xs" color="#F5F5F580">
                        Please review your transaction details.
                    </Text>
                </VStack>

                <Divider borderColor="#6943FF30" />

                {/* Transaction Details */}
                <Box
                    bg="#1A1D26"
                    borderRadius="md"
                    p={3}
                    maxH="150px"
                    overflow="auto"
                >
                    {children}
                </Box>

                {/* Error Display */}
                {error && (
                    <Box
                        bg="red.900"
                        border="1px solid"
                        borderColor="red.500"
                        borderRadius="md"
                        p={3}
                    >
                        <HStack spacing={2} align="flex-start">
                            <Icon as={AlertTriangle} w={4} h={4} color="red.300" mt={0.5} />
                            <Text fontSize="xs" color="red.200">
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
                        color="#F5F5F580"
                        onClick={onClose}
                        _hover={{ bg: '#6943FF20', color: '#F5F5F5' }}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg="#6943FF"
                        color="white"
                        isLoading={isLoading}
                        isDisabled={!canConfirm}
                        onClick={onConfirm}
                        _hover={{ bg: '#5a38e0' }}
                        _disabled={{ bg: '#6943FF60', cursor: 'not-allowed' }}
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
    const [explorer] = getExplorer(chain) || []
    const chainId = chain?.chain_id
    let txLink: string | undefined
    if (chainId === 'pion-1') {
        txLink = `https://neutron.celat.one/pion-1/txs/${transactionHash}`
    } else if (chainId === 'neutron-1') {
        txLink = `https://neutron.celat.one/neutron-1/txs/${transactionHash}`
    } else if (explorer?.tx_page) {
        txLink = explorer.tx_page.replace('${txHash}', transactionHash || '')
    }

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
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 15, delay: 0.1 }}
                    >
                        <Icon
                            as={isSuccess ? CheckCircle : XCircle}
                            w={12}
                            h={12}
                            color={isSuccess ? 'green.400' : 'red.400'}
                        />
                    </MotionBox>
                    <Text fontSize="md" fontWeight="bold" color="#F5F5F5">
                        {isSuccess ? 'Transaction Successful!' : 'Transaction Failed'}
                    </Text>
                    <Text fontSize="sm" color="#F5F5F5" textAlign="center">
                        {acknowledgementMessage}
                    </Text>
                    {/* Points Earned Display */}
                    {isSuccess && pointsEarned !== null && pointsEarned > 0 && (
                        <Box
                            bg="linear-gradient(135deg, #6943FF20 0%, #3BE5E520 100%)"
                            border="1px solid"
                            borderColor="purple.400"
                            borderRadius="md"
                            px={4}
                            py={2}
                            mt={2}
                        >
                            <HStack spacing={2} align="center">
                                <Text fontSize="xs" color="purple.300">
                                    Points Earned:
                                </Text>
                                <Text fontSize="sm" fontWeight="bold" color="purple.300">
                                    +{pointsEarned.toFixed(1)}
                                </Text>
                            </HStack>
                        </Box>
                    )}
                </VStack>

                <Divider borderColor="#6943FF30" />

                {/* Transaction Details */}
                <VStack spacing={2} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="#F5F5F580">
                            Status
                        </Text>
                        <Text
                            fontSize="xs"
                            fontWeight="bold"
                            color={isSuccess ? 'green.400' : 'red.400'}
                        >
                            {isSuccess ? 'Success' : 'Failed'}
                        </Text>
                    </HStack>

                    {txLink && transactionHash && (
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Transaction Hash
                            </Text>
                            <Link
                                href={txLink}
                                isExternal
                                color="purple.400"
                                fontSize="xs"
                                fontWeight="medium"
                                _hover={{ color: 'purple.300' }}
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
                            <Text fontSize="xs" color="#F5F5F580">
                                Gas Used
                            </Text>
                            <Text fontSize="xs" color="#F5F5F5">
                                {shiftDigits(gasUsed.toString(), -(osmo?.decimal || 6)).toString()}
                            </Text>
                        </HStack>
                    )}
                </VStack>

                {/* Close Button */}
                <Button
                    size="sm"
                    bg="#6943FF"
                    color="white"
                    onClick={onClose}
                    _hover={{ bg: '#5a38e0' }}
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
                    <Icon as={XCircle} w={12} h={12} color="red.400" />
                    <Text fontSize="md" fontWeight="bold" color="#F5F5F5">
                        Transaction Failed
                    </Text>
                    <Box
                        bg="red.900"
                        border="1px solid"
                        borderColor="red.500"
                        borderRadius="md"
                        p={3}
                        w="100%"
                    >
                        <Text fontSize="xs" color="red.200" textAlign="center">
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
                        color="#F5F5F580"
                        onClick={onClose}
                        _hover={{ bg: '#6943FF20', color: '#F5F5F5' }}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg="#6943FF"
                        color="white"
                        onClick={onRetry}
                        _hover={{ bg: '#5a38e0' }}
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
                        isLoading={isLoading}
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

