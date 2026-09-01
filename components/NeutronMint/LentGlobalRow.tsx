import React from 'react'
import {
    Box,
    HStack,
    VStack,
    Text,
    Image,
    Icon,
    Tr,
    Td,
    Progress,
    Tooltip,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    PopoverArrow,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon, InfoIcon } from '@chakra-ui/icons'
import { getSlotLabel } from '@/components/Disco/types'
import type { CurrentlyLentData } from './hooks/useCurrentlyLent'
import { formatLargeNumber, formatMbrn } from './LentFormat'

interface LentGlobalRowProps {
    data: CurrentlyLentData
    isExpanded: boolean
    setIsExpanded: React.Dispatch<React.SetStateAction<boolean>>
    vestingLabel: string
}

export const LentGlobalRow: React.FC<LentGlobalRowProps> = ({
    data,
    isExpanded,
    setIsExpanded,
    vestingLabel,
}) => {
    return (
        <Tr
            _hover={{ bg: 'whiteAlpha.50' }}
            cursor="pointer"
            onClick={() => setIsExpanded(!isExpanded)}
        >
            <Td px={2} py={3}>
                <HStack spacing={2}>
                    <Image
                        src="/images/usdc.svg"
                        alt="USDC"
                        w="24px"
                        h="24px"
                        borderRadius="full"
                        fallbackSrc="/images/default-token.svg"
                    />
                    <Text color="white" fontWeight="medium" fontSize="sm">
                        USDC
                    </Text>
                </HStack>
            </Td>
            <Td px={2} py={3} isNumeric>
                <Text color="white" fontSize="sm" fontWeight="medium">
                    {formatLargeNumber(data.totalAmount)}
                </Text>
            </Td>
            <Td px={2} py={3} isNumeric>
                <Text color={data.rewardVestingMbrn > 0 ? 'white' : 'whiteAlpha.700'} fontSize="sm">
                    {formatMbrn(data.rewardVestingMbrn)}
                </Text>
                <HStack spacing={1} justify="flex-start">
                    {/* <Box
                        w="6px"
                        h="6px"
                        borderRadius="full"
                        bg={"cyan.400"}
                    /> */}
                    <Text
                        fontSize="xs"
                        color="whiteAlpha.500"
                    >
                        {vestingLabel}
                    </Text>
                </HStack>
            </Td>
            <Td px={2} py={3} isNumeric>
                <Text
                    color={data.mbrnApr > 0 ? 'purple.300' : 'whiteAlpha.700'}
                    fontSize="sm"
                >
                    {data.mbrnApr > 0 ? `${data.mbrnApr.toFixed(2)}%` : '-'}
                </Text>
                {data.hasDeposits && (
                    <HStack spacing={1} justify="flex-start">
                        <Text
                            fontSize="xs"
                            color="whiteAlpha.500"
                        >
                            {data.vestingProgress >= 1
                                ? 'Max boost'
                                : `${Math.round(data.vestingProgress * 100)}% boost`}
                        </Text>
                        <Popover placement="bottom-end" trigger="hover">
                            <PopoverTrigger>
                                <span onClick={(e) => e.stopPropagation()}>
                                    <Icon
                                        as={InfoIcon}
                                        color="whiteAlpha.400"
                                        boxSize={3}
                                        cursor="help"
                                    />
                                </span>
                            </PopoverTrigger>
                            <PopoverContent
                                bg="rgba(10, 10, 10, 0.95)"
                                borderColor="whiteAlpha.200"
                                maxW="280px"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <PopoverArrow bg="rgba(10, 10, 10, 0.95)" />
                                <PopoverBody p={3}>
                                    <VStack spacing={3} align="stretch">
                                        <Text fontSize="xs" fontWeight="semibold" color="whiteAlpha.800">
                                            Retention Boost ({data.cliffPeriodDays}d ramp)
                                        </Text>
                                        {data.depositBoosts.map((boost, i) => (
                                            <Box key={`${boost.depositTime}-${boost.amount}`}>
                                                <HStack justify="space-between" mb={1}>
                                                    <Text fontSize="xs" color="white">
                                                        {formatLargeNumber(boost.amount)}
                                                    </Text>
                                                    <Text
                                                        fontSize="xs"
                                                        color={"cyan.400"}
                                                    >
                                                        {boost.isMaxed
                                                            ? 'Max'
                                                            : `${Math.round(boost.progress * 100)}% · ${boost.daysRemaining}d left`}
                                                    </Text>
                                                </HStack>
                                                <Progress
                                                    value={boost.progress * 100}
                                                    size="xs"
                                                    colorScheme={"cyan.400"}
                                                    bg="whiteAlpha.100"
                                                    borderRadius="full"
                                                />
                                            </Box>
                                        ))}
                                        {data.depositBoosts.length === 0 && (
                                            <Text fontSize="xs" color="whiteAlpha.500">
                                                No deposits yet
                                            </Text>
                                        )}
                                    </VStack>
                                </PopoverBody>
                            </PopoverContent>
                        </Popover>
                    </HStack>
                )}
            </Td>
            <Td px={2} py={3} isNumeric>
                <Tooltip
                    label={data.intentSlot
                        ? `${data.intentSlot.symbol || 'Asset'} Slot ${getSlotLabel(data.intentSlot.slot)}`
                        : 'No intent set'}
                    hasArrow
                    bg="rgba(10, 10, 10, 0.95)"
                    color="whiteAlpha.800"
                    fontSize="xs"
                >
                    <Text
                        color={data.insuranceApr > 0 ? 'cyan.400' : 'whiteAlpha.700'}
                        fontSize="sm"
                        cursor="help"
                    >
                        {data.insuranceApr > 0 ? `${data.insuranceApr.toFixed(2)}%` : '-'}
                    </Text>
                </Tooltip>
            </Td>
            <Td px={2} py={3}>
                {isExpanded
                    ? <ChevronUpIcon color="whiteAlpha.600" />
                    : <ChevronDownIcon color="whiteAlpha.600" />
                }
            </Td>
        </Tr>
    )
}
