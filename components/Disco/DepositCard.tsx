import React, { useState } from 'react'
import { Box, HStack, VStack, Text, Icon, Tooltip } from '@chakra-ui/react'
import { LockIcon } from '@chakra-ui/icons'
import { formatLockDuration, sortDepositsByLTVPair } from './utils'
import { shiftDigits } from '@/helpers/math'
import { FunnelAnimation } from './FunnelAnimation'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS } from '@/config/transitions'

interface DepositCardProps {
    deposit: any
    asset: string
    onClick?: () => void
}

export const DepositCard = React.memo(({ deposit, asset, onClick }: DepositCardProps) => {
    const [showDistribution, setShowDistribution] = useState(false)

    const locked = deposit.locked || deposit.deposit?.locked
    const isLocked = locked && locked.locked_until > Math.floor(Date.now() / 1000)
    const lockDuration = isLocked ? formatLockDuration(locked) : null
    const vaultTokens = deposit.vault_tokens || deposit.deposit?.vault_tokens || '0'
    const lockedVaultTokens = deposit.locked_vault_tokens || deposit.deposit?.locked_vault_tokens || '0'
    // LTV might be in deposit.ltv, deposit.max_ltv, or need to be extracted from deposit key
    const ltv = deposit.ltv || deposit.max_ltv || deposit.deposit?.ltv || '0'
    const maxBorrowLtv = deposit.max_borrow_ltv || deposit.deposit?.max_borrow_ltv || '0'

    // Format amounts (assuming 6 decimals)
    const formattedAmount = shiftDigits(vaultTokens, -6).toString()
    const formattedLocked = shiftDigits(lockedVaultTokens, -6).toString()

    // Convert LTV values to strings if they're BigNumber or other objects
    const ltvStr = typeof ltv === 'object' ? (ltv?.toString?.() || String(ltv)) : String(ltv)
    const maxBorrowLtvStr = typeof maxBorrowLtv === 'object' ? (maxBorrowLtv?.toString?.() || String(maxBorrowLtv)) : String(maxBorrowLtv)

    // Calculate earning percentage (placeholder - would need actual revenue data)
    const earningPercent = "8%" // This would come from actual revenue calculations

    const handleClick = () => {
        setShowDistribution(!showDistribution)
        if (onClick) onClick()
    }

    return (
        <Box position="relative" mb={4}>
            {/* LTV Pair Label - Top right above card */}
            <Box
                position="absolute"
                top="-20px"
                right="0"
                fontSize="xs"
                color="whiteAlpha.700"
                fontFamily="mono"
            >
                ({maxBorrowLtvStr}, {ltvStr})
            </Box>

            {/* Main Card */}
            <Box
                as="button"
                onClick={handleClick}
                w="100%"
                p={4}
                bg="whiteAlpha.50"
                border="1px solid"
                borderColor="whiteAlpha.200"
                borderRadius="md"
                cursor="pointer"
                // Enhanced hover with lift and border highlight
                transition={TRANSITIONS.transformAndShadow}
                _hover={{
                    ...HOVER_EFFECTS.liftSubtle,
                    borderColor: "whiteAlpha.400",
                    bg: "whiteAlpha.100",
                }}
                _active={{
                    ...ACTIVE_EFFECTS.pressDown,
                    bg: "whiteAlpha.150",
                }}
                position="relative"
            >
                <HStack justify="space-between" align="start">
                    {/* Left side - Deposit info */}
                    <VStack align="start" spacing={2} flex={1}>
                        <Text fontSize="sm" color="whiteAlpha.600">
                            Asset: {asset}
                        </Text>
                        <Text fontSize="lg" fontWeight="bold">
                            {formattedAmount} MBRN
                        </Text>
                        {!isLocked && (
                            <Text fontSize="sm" color="green.400">
                                Earning {earningPercent}
                            </Text>
                        )}
                    </VStack>

                    {/* Right side - Lock visualization */}
                    <Box position="relative">
                        {isLocked ? (
                            <Tooltip label={`Locked: ${lockDuration} remaining`}>
                                <HStack spacing={2}>
                                    <Icon as={LockIcon} w={6} h={6} color="blue.400" />
                                    <Text fontSize="lg" fontWeight="bold" color="blue.400">
                                        {formattedLocked}
                                    </Text>
                                </HStack>
                            </Tooltip>
                        ) : (
                            <VStack align="end" spacing={1}>
                                <Text fontSize="lg" fontWeight="bold">
                                    {formattedAmount} MBRN
                                </Text>
                                <Text fontSize="sm" color="green.400">
                                    earning {earningPercent}
                                </Text>
                            </VStack>
                        )}

                        {/* Connector line to distribution visualization */}
                        {showDistribution && (
                            <Box
                                position="absolute"
                                right="-100px"
                                top="50%"
                                w="80px"
                                h="2px"
                                bg="blue.400"
                                transform="translateY(-50%)"
                            />
                        )}
                    </Box>
                </HStack>
            </Box>

            {/* Distribution visualization (shown when clicked) */}
            {showDistribution && (
                <FunnelAnimation
                    deposit={deposit}
                    asset={asset}
                    onClose={() => setShowDistribution(false)}
                />
            )}
        </Box>
    )
})

DepositCard.displayName = 'DepositCard'

