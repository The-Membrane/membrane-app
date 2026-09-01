import React from 'react'
import {
    Text,
    Table,
    Thead,
    Tbody,
    Tr,
    Th,
    Td,
    Button,
    Progress,
    Tooltip,
} from '@chakra-ui/react'
import { getSlotLabel } from '@/components/Disco/types'
import type { CurrentlyLentData } from './hooks/useCurrentlyLent'
import { formatLargeNumber, formatMbrn } from './LentFormat'
import { LentGlobalRow } from './LentGlobalRow'

interface CurrentlyLentDesktopTableProps {
    data: CurrentlyLentData
    isExpanded: boolean
    setIsExpanded: React.Dispatch<React.SetStateAction<boolean>>
    vestingLabel: string
}

export const CurrentlyLentDesktopTable: React.FC<CurrentlyLentDesktopTableProps> = ({
    data,
    isExpanded,
    setIsExpanded,
    vestingLabel,
}) => {
    return (
        <Table variant="unstyled" size="sm">
            <Thead>
                <Tr>
                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
                        Asset
                    </Th>
                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                        Amount
                    </Th>
                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                        Reward Vesting
                    </Th>
                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                        MBRN APR
                    </Th>
                    <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                        Est. Insurance APR
                    </Th>
                    <Th px={2} width="100px"></Th>
                </Tr>
            </Thead>
            <Tbody>
                {/* Global combined row */}
                <LentGlobalRow
                    data={data}
                    isExpanded={isExpanded}
                    setIsExpanded={setIsExpanded}
                    vestingLabel={vestingLabel}
                />

                {/* Vesting progress bar row */}
                {data.vestingDaysRemaining > 0 && (
                    <Tr>
                        <Td colSpan={6} px={2} py={1}>
                            <Progress
                                value={data.vestingProgress * 100}
                                size="xs"
                                colorScheme="purple"
                                bg="whiteAlpha.100"
                                borderRadius="full"
                            />
                        </Td>
                    </Tr>
                )}

                {/* Expanded sub-rows — same table, same column grid */}
                {isExpanded && data.acquisitionAmount > 0 && (
                    <Tr _hover={{ bg: 'whiteAlpha.50' }}>
                        <Td px={2} py={3} pl={10}>
                            <Text color="purple.300" fontSize="xs" fontWeight="medium">
                                Acquisition
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text color="white" fontWeight="medium" fontSize="sm">
                                {formatLargeNumber(data.acquisitionAmount)}
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text color={data.rewardVestingMbrn > 0 ? 'white' : 'whiteAlpha.700'} fontSize="sm">
                                {formatMbrn(data.rewardVestingMbrn)}
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text
                                color={data.mbrnApr > 0 ? 'purple.300' : 'whiteAlpha.700'}
                                fontSize="sm"
                            >
                                {data.mbrnApr > 0 ? `${data.mbrnApr.toFixed(2)}%` : '-'}
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Tooltip
                                label={data.acquisitionIntentSlot
                                    ? `Slot ${getSlotLabel(data.acquisitionIntentSlot.slot)}`
                                    : 'No intent set'}
                                hasArrow
                                bg="rgba(10, 10, 10, 0.95)"
                                color="whiteAlpha.800"
                                fontSize="xs"
                            >
                                <Text
                                    color={data.acquisitionInsuranceApr > 0 ? 'cyan.400' : 'whiteAlpha.700'}
                                    fontSize="sm"
                                    cursor="help"
                                >
                                    {data.acquisitionInsuranceApr > 0 ? `${data.acquisitionInsuranceApr.toFixed(2)}%` : '-'}
                                </Text>
                            </Tooltip>
                        </Td>
                        <Td px={2} py={3}>
                            <Button
                                size="xs"
                                variant="outline"
                                colorScheme="purple"
                                color="purple.300"
                                borderColor="purple.400"
                                _hover={{ bg: 'purple.500', color: 'white', borderColor: 'purple.500' }}
                            >
                                Manage
                            </Button>
                        </Td>
                    </Tr>
                )}

                {isExpanded && data.baseAmount > 0 && (
                    <Tr _hover={{ bg: 'whiteAlpha.50' }}>
                        <Td px={2} py={3} pl={10}>
                            <Text color="whiteAlpha.500" fontSize="xs" fontWeight="medium">
                                Base
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text color="white" fontWeight="medium" fontSize="sm">
                                {formatLargeNumber(data.baseAmount)}
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text color="whiteAlpha.700" fontSize="sm">-</Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Text
                                color={data.mbrnApr > 0 ? 'purple.300' : 'whiteAlpha.700'}
                                fontSize="sm"
                            >
                                {data.mbrnApr > 0 ? `${data.mbrnApr.toFixed(2)}%` : '-'}
                            </Text>
                        </Td>
                        <Td px={2} py={3} isNumeric>
                            <Tooltip
                                label={data.baseIntentSlot
                                    ? `Slot ${getSlotLabel(data.baseIntentSlot.slot)}`
                                    : 'No intent set'}
                                hasArrow
                                bg="rgba(10, 10, 10, 0.95)"
                                color="whiteAlpha.800"
                                fontSize="xs"
                            >
                                <Text
                                    color={data.baseInsuranceApr > 0 ? 'cyan.400' : 'whiteAlpha.700'}
                                    fontSize="sm"
                                    cursor="help"
                                >
                                    {data.baseInsuranceApr > 0 ? `${data.baseInsuranceApr.toFixed(2)}%` : '-'}
                                </Text>
                            </Tooltip>
                        </Td>
                        <Td px={2} py={3}>
                            <Button
                                size="xs"
                                variant="outline"
                                colorScheme="purple"
                                color="purple.300"
                                borderColor="purple.400"
                                _hover={{ bg: 'purple.500', color: 'white', borderColor: 'purple.500' }}
                            >
                                Manage
                            </Button>
                        </Td>
                    </Tr>
                )}
            </Tbody>
        </Table>
    )
}
