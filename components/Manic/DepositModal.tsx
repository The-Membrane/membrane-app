import React, { useState, ChangeEvent } from 'react'
import {
    Box,
    VStack,
    HStack,
    Input,
    Text,
    Image,
    Button,
    IconButton
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { motion, AnimatePresence } from 'framer-motion'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { Formatter } from '@/helpers/formatter'
import { num } from '@/helpers/num'
import { CloseIcon } from '@chakra-ui/icons'

interface DepositCardProps {
    isOpen: boolean
    onClose: () => void
    onDeposit: (amount: string) => void
    inline?: boolean
    hideUsdValue?: boolean
}

export const DepositCard: React.FC<DepositCardProps> = ({
    isOpen,
    onClose,
    onDeposit,
    inline = false,
    hideUsdValue = false,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)
    const [amount, setAmount] = useState('')

    const handleAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        // Allow empty string, numbers, and one decimal point
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setAmount(value)
        }
    }

    const handleMaxClick = () => {
        setAmount(usdcBalance.toString())
    }

    const handleDeposit = () => {
        if (amount && parseFloat(amount) > 0) {
            onDeposit(amount)
            setAmount('')
        }
    }

    // USDC price is typically 1, but get from oracle if available
    const usdcPrice = 1 // USDC is typically $1
    const usdValue = num(amount || 0).times(usdcPrice).toFixed(2)

    return (
        <motion.div
            key="deposit-card"
            initial={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            transition={{
                duration: 0.4,
                ease: [0.16, 1, 0.3, 1],
                opacity: { duration: 0.3 },
                scale: { duration: 0.4 }
            }}
            style={{
                position: inline ? 'relative' : 'absolute',
                transformOrigin: 'center center',
                width: inline ? '100%' : '500px',
                zIndex: inline ? 1 : 30
            }}
        >
            <Box
                bg="gray.800"
                border="2px solid"
                borderColor="cyan.500"
                borderRadius="xl"
                boxShadow="0 0 40px rgba(0, 191, 255, 0.3)"
                p={6}
                position="relative"
            >
                {/* Close button */}
                <Box position="absolute" top={4} right={4} width="15%" display="flex" justifyContent="flex-end">
                    <IconButton
                        aria-label="Close"
                        icon={<CloseIcon />}
                        size="sm"
                        variant="ghost"
                        color="white"
                        onClick={onClose}
                        _hover={{ bg: 'gray.700' }}
                    />
                </Box>

                <VStack spacing={6} align="stretch">
                    {/* Header */}
                    <Text
                        fontSize={TYPOGRAPHY.h3}
                        fontWeight={TYPOGRAPHY.bold}
                        bgGradient="linear(to-r, cyan.400, blue.500)"
                        bgClip="text"
                        fontFamily="mono"
                    >
                        Deposit USDC
                    </Text>

                    {/* Amount input section */}
                    <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                        <HStack justify="space-between" align="flex-start" w="100%">
                            <VStack align="flex-start" spacing={1} flex={1}>
                                <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
                                    Deposit Amount
                                </Text>
                                <Input
                                    variant="unstyled"
                                    fontSize="3xl"
                                    fontWeight="bold"
                                    color="white"
                                    value={amount}
                                    onChange={handleAmountChange}
                                    type="text"
                                    placeholder="0"
                                    w="100%"
                                    _placeholder={{ color: 'whiteAlpha.400' }}
                                    paddingInlineEnd="3"
                                    autoFocus
                                />
                                {!hideUsdValue && (
                                    <Text color="whiteAlpha.600" fontSize="md">
                                        ~ ${usdValue}
                                    </Text>
                                )}
                            </VStack>
                            <VStack align="flex-end" spacing={2}>
                                <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                    {usdcAsset?.logo && (
                                        <Image
                                            src={usdcAsset.logo}
                                            alt="USDC"
                                            boxSize="24px"
                                        />
                                    )}
                                    <Text color="white" fontWeight="bold">
                                        USDC
                                    </Text>
                                </HStack>
                                <VStack
                                    cursor="pointer"
                                    onClick={handleMaxClick}
                                    sx={{
                                        '&:hover > .wallet-hover-text': {
                                            textDecoration: 'underline',
                                            color: 'blue.300',
                                        },
                                    }}
                                >
                                    <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                                        Wallet
                                    </Text>
                                    <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                                        {Formatter.toNearestNonZero(usdcBalance)}
                                    </Text>
                                </VStack>
                            </VStack>
                        </HStack>
                    </Box>

                    {/* Deposit button */}
                    <Button
                        size="lg"
                        colorScheme="cyan"
                        bg="cyan.500"
                        color="white"
                        isDisabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > Number(usdcBalance)}
                        onClick={handleDeposit}
                        _hover={{
                            bg: 'cyan.400',
                        }}
                        fontFamily="mono"
                        fontSize="lg"
                    >
                        Deposit
                    </Button>
                </VStack>
            </Box>
        </motion.div>
    )
}

interface WithdrawCardProps {
    isOpen: boolean
    onClose: () => void
    onWithdraw: (amount: string) => void
    inline?: boolean
    tvlAmount?: number // TVL amount to use as max
}

export const WithdrawCard: React.FC<WithdrawCardProps> = ({
    isOpen,
    onClose,
    onWithdraw,
    inline = false,
    tvlAmount = 0,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const [amount, setAmount] = useState('')

    const handleAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        // Allow empty string, numbers, and one decimal point
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setAmount(value)
        }
    }

    const handleMaxClick = () => {
        setAmount(tvlAmount.toString())
    }

    const handleWithdraw = () => {
        if (amount && parseFloat(amount) > 0) {
            onWithdraw(amount)
            setAmount('')
        }
    }

    // USDC price is typically 1, but get from oracle if available
    const usdcPrice = 1 // USDC is typically $1
    const usdValue = num(amount || 0).times(usdcPrice).toFixed(2)

    return (
        <motion.div
            key="withdraw-card"
            initial={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: inline ? 1 : 0.3 }}
            transition={{
                duration: 0.4,
                ease: [0.16, 1, 0.3, 1],
                opacity: { duration: 0.3 },
                scale: { duration: 0.4 }
            }}
            style={{
                position: inline ? 'relative' : 'absolute',
                transformOrigin: 'center center',
                width: inline ? '100%' : '500px',
                zIndex: inline ? 1 : 30
            }}
        >
            <Box
                bg="gray.800"
                border="2px solid"
                borderColor="cyan.500"
                borderRadius="xl"
                boxShadow="0 0 40px rgba(0, 191, 255, 0.3)"
                p={6}
                position="relative"
            >
                {/* Close button */}
                <Box position="absolute" top={4} right={4} width="15%" display="flex" justifyContent="flex-end">
                    <IconButton
                        aria-label="Close"
                        icon={<CloseIcon />}
                        size="sm"
                        variant="ghost"
                        color="white"
                        onClick={onClose}
                        _hover={{ bg: 'gray.700' }}
                    />
                </Box>

                <VStack spacing={6} align="stretch">
                    {/* Header */}
                    <Text
                        fontSize={TYPOGRAPHY.h3}
                        fontWeight={TYPOGRAPHY.bold}
                        bgGradient="linear(to-r, cyan.400, blue.500)"
                        bgClip="text"
                        fontFamily="mono"
                    >
                        Withdraw USDC
                    </Text>

                    {/* Amount input section */}
                    <Box w="100%" bg="#11161e" borderRadius="lg" p={5}>
                        <HStack justify="space-between" align="flex-start" w="100%">
                            <VStack align="flex-start" spacing={1} flex={1}>
                                <Text color="whiteAlpha.700" fontSize="sm" fontWeight="medium">
                                    Withdraw Amount
                                </Text>
                                <Input
                                    variant="unstyled"
                                    fontSize="3xl"
                                    fontWeight="bold"
                                    color="white"
                                    value={amount}
                                    onChange={handleAmountChange}
                                    type="text"
                                    placeholder="0"
                                    w="100%"
                                    _placeholder={{ color: 'whiteAlpha.400' }}
                                    paddingInlineEnd="3"
                                    autoFocus
                                />
                                <Text color="whiteAlpha.600" fontSize="md">
                                    ~ ${usdValue}
                                </Text>
                            </VStack>
                            <VStack align="flex-end" spacing={2}>
                                <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
                                    {usdcAsset?.logo && (
                                        <Image
                                            src={usdcAsset.logo}
                                            alt="USDC"
                                            boxSize="24px"
                                        />
                                    )}
                                    <Text color="white" fontWeight="bold">
                                        USDC
                                    </Text>
                                </HStack>
                                <VStack
                                    cursor="pointer"
                                    onClick={handleMaxClick}
                                    sx={{
                                        '&:hover > .tvl-hover-text': {
                                            textDecoration: 'underline',
                                            color: 'blue.300',
                                        },
                                    }}
                                >
                                    <Text className="tvl-hover-text" color="whiteAlpha.700" fontSize="md">
                                        TVL
                                    </Text>
                                    <Text className="tvl-hover-text" color="whiteAlpha.700" fontSize="md">
                                        {Formatter.toNearestNonZero(tvlAmount)}
                                    </Text>
                                </VStack>
                            </VStack>
                        </HStack>
                    </Box>

                    {/* Withdraw button */}
                    <Button
                        size="lg"
                        colorScheme="cyan"
                        bg="cyan.500"
                        color="white"
                        isDisabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > tvlAmount}
                        onClick={handleWithdraw}
                        _hover={{
                            bg: 'cyan.400',
                        }}
                        fontFamily="mono"
                        fontSize="lg"
                    >
                        Withdraw
                    </Button>
                </VStack>
            </Box>
        </motion.div>
    )
}

