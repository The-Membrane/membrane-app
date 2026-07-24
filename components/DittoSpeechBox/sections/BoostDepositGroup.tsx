import React from 'react'
import { VStack, Text, Box, HStack, Icon, BoxProps } from '@chakra-ui/react'
import { Pencil } from 'lucide-react'
import { BoostDeposit } from './BoostTypes'

interface BoostDepositGroupProps {
    title: string
    type: 'staking' | 'disco'
    baseMBRN: string
    lockedDeposits: BoostDeposit[]
    totalEffectiveMBRN: string
    totalEffectiveColor: string
    formatMBRN: (amount: string) => string
    boostContribution: (deposit: BoostDeposit) => string
    onNewDeposit: (type: 'staking' | 'disco') => void
    onDepositClick: (type: 'staking' | 'disco', index: number) => void
    isSelected: (type: 'staking' | 'disco', index: number) => boolean
    getDepositStyles: (type: 'staking' | 'disco', index: number) => BoxProps
}

export const BoostDepositGroup: React.FC<BoostDepositGroupProps> = ({
    title,
    type,
    baseMBRN,
    lockedDeposits,
    totalEffectiveMBRN,
    totalEffectiveColor,
    formatMBRN,
    boostContribution,
    onNewDeposit,
    onDepositClick,
    isSelected,
    getDepositStyles,
}) => {
    return (
        <Box>
            <HStack
                mb={2}
                cursor="pointer"
                onClick={() => onNewDeposit(type)}
                _hover={{ opacity: 0.8 }}
                transition="opacity 0.2s"
            >
                <Text fontSize="xs" color="#ece6d880" fontWeight="bold">
                    {title}
                </Text>
                <Icon as={Pencil} w={3} h={3} color="#ece6d850" />
            </HStack>
            <VStack align="stretch" spacing={2}>
                <HStack justify="space-between">
                    <Text fontSize="xs" color="#ece6d880">
                        Base MBRN
                    </Text>
                    <Text fontSize="xs" color="#ece6d8" fontWeight="bold">
                        {formatMBRN(baseMBRN)} MBRN
                    </Text>
                </HStack>
                {lockedDeposits.length > 0 && (
                    <VStack align="stretch" spacing={2} mt={2}>
                        {lockedDeposits.map((deposit, idx) => (
                            <Box
                                key={deposit.lockedUntil}
                                onClick={() => onDepositClick(type, idx)}
                                {...getDepositStyles(type, idx)}
                            >
                                <Box bg="#1A1D26" borderRadius="md" position="relative" zIndex={1}>
                                    {/* Edit icon indicator */}
                                    <HStack justify="flex-end" mb={1}>
                                        <Icon
                                            as={Pencil}
                                            w={3}
                                            h={3}
                                            color={isSelected(type, idx) ? '#9F7AEA' : '#ece6d850'}
                                            opacity={isSelected(type, idx) ? 1 : 0.5}
                                            transition="opacity 0.2s"
                                        />
                                    </HStack>
                                    <VStack align="stretch" spacing={2}>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="#ece6d880">
                                                Deposit Amount
                                            </Text>
                                            <Text fontSize="xs" color="#ece6d8" fontWeight="bold">
                                                {formatMBRN(deposit.amount)} MBRN
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="#ece6d880">
                                                Lock Duration
                                            </Text>
                                            <Text fontSize="xs" color="primary.300">
                                                {deposit.daysRemaining} days
                                            </Text>
                                        </HStack>
                                        <HStack justify="space-between">
                                            <Text fontSize="xs" color="#ece6d880">
                                                Boost Contribution
                                            </Text>
                                            <Text fontSize="xs" color="secondary.300" fontWeight="bold">
                                                +{boostContribution(deposit)} MBRN
                                            </Text>
                                        </HStack>
                                    </VStack>
                                </Box>
                            </Box>
                        ))}
                    </VStack>
                )}
                <HStack justify="space-between" mt={2}>
                    <Text fontSize="xs" fontWeight="bold" color="#ece6d880">
                        Total Effective MBRN
                    </Text>
                    <Text fontSize="xs" fontWeight="bold" color={totalEffectiveColor}>
                        {formatMBRN(totalEffectiveMBRN)} MBRN
                    </Text>
                </HStack>
            </VStack>
        </Box>
    )
}
