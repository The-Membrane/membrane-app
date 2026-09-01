import React from 'react'
import {
    Box,
    HStack,
    VStack,
    Text,
    Image,
    Icon,
    Progress,
    Tooltip,
    Popover,
    PopoverTrigger,
    PopoverContent,
    PopoverBody,
    PopoverArrow,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { MobileCard, MobileCardDataItem } from '@/components/ui/ResponsiveTable'
import { getSlotLabel } from '@/components/Disco/types'
import type { CurrentlyLentData } from './hooks/useCurrentlyLent'
import { formatLargeNumber, formatMbrn } from './LentFormat'

interface CurrentlyLentMobileCardsProps {
    data: CurrentlyLentData
    isExpanded: boolean
    setIsExpanded: React.Dispatch<React.SetStateAction<boolean>>
    vestingLabel: string
}

// Mobile cards for expanded sub-rows
const renderMobileSubRow = (label: string, amount: number, mbrn: number, apr: number) => {
    const subData: MobileCardDataItem[] = [
        {
            label: 'Amount',
            value: (
                <VStack spacing={0} align="flex-end">
                    <Text color="white">{formatLargeNumber(amount)}</Text>
                    <Text fontSize="xs" color="whiteAlpha.500">{label}</Text>
                </VStack>
            ),
        },
        {
            label: 'Reward Vesting',
            value: (
                <Text color={mbrn > 0 ? 'white' : 'whiteAlpha.700'}>
                    {formatMbrn(mbrn)}
                </Text>
            ),
        },
        {
            label: 'Est. Insurance APR',
            value: (
                <Text color={apr > 0 ? 'cyan.400' : 'whiteAlpha.700'}>
                    {apr > 0 ? `${apr.toFixed(2)}%` : '-'}
                </Text>
            ),
        },
    ]
    return <MobileCard key={label} data={subData} />
}

export const CurrentlyLentMobileCards: React.FC<CurrentlyLentMobileCardsProps> = ({
    data,
    isExpanded,
    setIsExpanded,
    vestingLabel,
}) => {
    // Mobile card for global row
    const renderMobileGlobal = () => {
        const cardData: MobileCardDataItem[] = [
            {
                label: 'Asset',
                value: (
                    <HStack spacing={2} justify="flex-end">
                        <Image
                            src="/images/usdc.svg"
                            alt="USDC"
                            w="20px"
                            h="20px"
                            borderRadius="full"
                            fallbackSrc="/images/default-token.svg"
                        />
                        <Text fontWeight="medium">USDC</Text>
                    </HStack>
                ),
            },
            {
                label: 'Amount',
                value: (
                    <Text color="white" fontWeight="medium">
                        {formatLargeNumber(data.totalAmount)}
                    </Text>
                ),
            },
            {
                label: 'Reward Vesting',
                value: (
                    <VStack spacing={0} align="flex-end">
                        <Text color={data.rewardVestingMbrn > 0 ? 'white' : 'whiteAlpha.700'}>
                            {formatMbrn(data.rewardVestingMbrn)}
                        </Text>
                        <Text fontSize="xs" color="whiteAlpha.500">
                            {vestingLabel}
                        </Text>
                    </VStack>
                ),
            },
            {
                label: 'MBRN APR',
                value: (
                    <VStack spacing={0} align="flex-end">
                        <Text color={data.mbrnApr > 0 ? 'purple.300' : 'whiteAlpha.700'}>
                            {data.mbrnApr > 0 ? `${data.mbrnApr.toFixed(2)}%` : '-'}
                        </Text>
                        {data.hasDeposits && (
                            <HStack spacing={1}>
                                <Text
                                    fontSize="xs"
                                    color="whiteAlpha.500"
                                >
                                    {data.vestingProgress >= 1
                                        ? 'Max boost'
                                        : `${Math.round(data.vestingProgress * 100)}% boost`}
                                </Text>
                                <Popover placement="bottom-end">
                                    <PopoverTrigger>
                                        <span onClick={(e) => e.stopPropagation()}>
                                            <Icon
                                                as={InfoIcon}
                                                color="whiteAlpha.400"
                                                boxSize={3}
                                                cursor="pointer"
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
                                                            <Text fontSize="xs" color="whiteAlpha.600">
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
                    </VStack>
                ),
            },
            {
                label: 'Est. Insurance APR',
                value: (
                    <Tooltip
                        label={data.intentSlot ? `${getSlotLabel(data.intentSlot.slot)} tranche` : 'No intent set'}
                        hasArrow
                    >
                        <Text color={data.insuranceApr > 0 ? 'cyan.400' : 'whiteAlpha.700'}>
                            {data.insuranceApr > 0 ? `${data.insuranceApr.toFixed(2)}%` : '-'}
                        </Text>
                    </Tooltip>
                ),
            },
        ]
        return <MobileCard data={cardData} onClick={() => setIsExpanded(!isExpanded)} />
    }

    return (
        <>
            {renderMobileGlobal()}
            {data.vestingDaysRemaining > 0 && (
                <Progress
                    value={data.vestingProgress * 100}
                    size="xs"
                    colorScheme="purple"
                    bg="whiteAlpha.100"
                    borderRadius="full"
                    mt={1}
                />
            )}
            {isExpanded && (
                <>
                    {data.acquisitionAmount > 0 && renderMobileSubRow(
                        'Acquisition',
                        data.acquisitionAmount,
                        data.rewardVestingMbrn,
                        data.insuranceApr,
                    )}
                    {data.baseAmount > 0 && renderMobileSubRow(
                        'Base',
                        data.baseAmount,
                        0,
                        0,
                    )}
                </>
            )}
        </>
    )
}
