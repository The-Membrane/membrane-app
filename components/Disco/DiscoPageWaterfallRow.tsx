import React from 'react'
import { Box, HStack, Stack, Text, Icon, Button, Collapse } from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon, TimeIcon } from '@chakra-ui/icons'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from './types'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageWaterfallRowProps {
    slot: number
    amount: number
    claimable: number
    apr: number
    idx: number
    userSlotDeposits: DiscoPageState['userSlotDeposits']
    unstakeData: DiscoPageState['unstakeData']
    bufferData: DiscoPageState['bufferData']
    expandedUserSlots: DiscoPageState['expandedUserSlots']
    setExpandedUserSlots: DiscoPageState['setExpandedUserSlots']
    setManageSlot: DiscoPageState['setManageSlot']
}

/** Single expandable slot row in the user deposits waterfall. */
export const DiscoPageWaterfallRow: React.FC<DiscoPageWaterfallRowProps> = ({
    slot,
    amount,
    claimable,
    apr,
    idx,
    userSlotDeposits,
    unstakeData,
    bufferData,
    expandedUserSlots,
    setExpandedUserSlots,
    setManageSlot,
}) => {
    const fillPct = userSlotDeposits.maxAmount > 0 ? (amount / userSlotDeposits.maxAmount) * 100 : 0
    const tvlRatio = userSlotDeposits.maxAmount > 0 ? amount / userSlotDeposits.maxAmount : 0
    const totalUserSlots = userSlotDeposits.slots.length
    const t = totalUserSlots > 1 ? idx / (totalUserSlots - 1) : 0
    const r = Math.round(34 + (166 - 34) * t)
    const g = Math.round(211 + (146 - 211) * t)
    const b = Math.round(238 + (255 - 238) * t)

    // Unstaking data for this slot
    const slotUnstakes = (unstakeData?.requests || []).filter((req: any) => req.slot === slot)
    const unstakingAmount = slotUnstakes.reduce((sum: number, req: any) => {
        const tokens = parseFloat(req.vault_tokens || '0')
        return sum + shiftDigits(tokens.toString(), -6).toNumber()
    }, 0)
    const nearestUnlock = slotUnstakes.length > 0
        ? Math.min(...slotUnstakes.map((req: any) => req.unlock_time))
        : 0
    const unstakeHoursLeft = nearestUnlock > 0
        ? Math.max(0, Math.ceil((nearestUnlock - Math.floor(Date.now() / 1000)) / 3600))
        : 0
    const opacity = 0.15 + 0.7 * tvlRatio
    const barColor = `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`
    const slotColor = `rgb(${r}, ${g}, ${b})`
    const isExpanded = expandedUserSlots.has(slot)

    // Buffer: global TVL ahead of this deposit
    const mbrnAhead = bufferData.get(slot) || 0
    const bufferDisplay = mbrnAhead > 0
        ? parseFloat(shiftDigits(mbrnAhead.toString(), -6).toString()).toLocaleString(undefined, { maximumFractionDigits: 0 })
        : '0'

    return (
        <Box>
            {/* Buffer row: shows global TVL ahead (hidden when 0) */}
            {mbrnAhead > 0 && (
            <Box
                px={3}
                py={1}
                borderRadius="sm"
                bg="rgba(72, 187, 120, 0.08)"
                border="1px solid rgba(72, 187, 120, 0.2)"
                mb={1}
            >
                <HStack justify="space-between">
                    <Text fontSize="2xs" color="green.400" fontFamily="mono">
                        BUFFER
                    </Text>
                    <Text fontSize="2xs" color="green.400" fontFamily="mono">
                        {bufferDisplay} MBRN ahead
                    </Text>
                </HStack>
            </Box>
            )}

            {/* Deposit row */}
            <Box
                position="relative"
                px={3}
                py={2.5}
                borderRadius="md"
                borderBottomRadius={isExpanded ? 0 : 'md'}
                border="1px solid"
                borderColor={isExpanded ? `rgba(${r}, ${g}, ${b}, 0.4)` : 'rgba(155, 220, 79, 0.15)'}
                borderBottom={isExpanded ? 'none' : undefined}
                bg="rgba(10, 10, 10, 0.6)"
                overflow="hidden"
                cursor="pointer"
                onClick={() => {
                    setExpandedUserSlots(prev => {
                        const next = new Set(prev)
                        if (next.has(slot)) next.delete(slot)
                        else next.add(slot)
                        return next
                    })
                }}
                _hover={{ borderColor: `rgba(${r}, ${g}, ${b}, 0.4)` }}
                transition="all 0.15s ease"
            >
                {/* Fill bar */}
                <Box
                    position="absolute"
                    top={0}
                    left={0}
                    bottom={0}
                    w={`${Math.max(fillPct, 2)}%`}
                    bg={barColor}
                    borderRadius="md"
                    transition="width 0.4s ease, background 0.2s ease"
                />

                {/* Content */}
                <HStack justify="space-between" spacing={2} position="relative" zIndex={1}>
                    {unstakingAmount > 0 ? (
                        <TimeIcon
                            color="orange.300"
                            w="18px"
                            h="18px"
                            minW="36px"
                        />
                    ) : (
                        <Text
                            fontSize="sm"
                            fontWeight="bold"
                            color="whiteAlpha.900"
                            fontFamily="mono"
                            minW="36px"
                        >
                            {getSlotLabel(slot)}
                        </Text>
                    )}
                    <HStack spacing={2}>
                        {!isExpanded && (
                            <Text
                                fontSize="xs"
                                fontWeight="bold"
                                color="whiteAlpha.800"
                                fontFamily="mono"
                            >
                                {amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </Text>
                        )}
                        <Icon
                            as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                            color="whiteAlpha.500"
                            w={4}
                            h={4}
                            transition="transform 0.2s ease"
                            _hover={{ color: 'whiteAlpha.800' }}
                        />
                    </HStack>
                </HStack>
            </Box>

            {/* Expanded details */}
            <Collapse in={isExpanded} animateOpacity>
                <Box
                    p={3}
                    pb={unstakingAmount > 0 ? 5 : 3}
                    bg="rgba(0, 0, 0, 0.3)"
                    borderLeft="1px solid"
                    borderRight="1px solid"
                    borderBottom="1px solid"
                    borderColor={`rgba(${r}, ${g}, ${b}, 0.4)`}
                    borderBottomRadius="md"
                >
                    <HStack spacing={4} justify="space-between">
                        <HStack spacing={8} flex={1} justify="center">
                            <Stack spacing={0}>
                                <Text color="whiteAlpha.500" fontSize="sm" fontFamily="mono">
                                    TVL
                                </Text>
                                <Text color="white" fontSize="lg" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                    {amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </Text>
                            </Stack>
                            <Stack spacing={0}>
                                <Text color="whiteAlpha.500" fontSize="sm" fontFamily="mono">
                                    APR
                                </Text>
                                <Text color="white" fontSize="lg" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                    {apr.toFixed(1)}%
                                </Text>
                            </Stack>
                            <Stack spacing={0}>
                                <Text color="whiteAlpha.500" fontSize="sm" fontFamily="mono">
                                    Claimable
                                </Text>
                                <Text color="secondary.400" fontSize="lg" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                    {claimable.toFixed(2)}
                                </Text>
                            </Stack>
                            {unstakingAmount > 0 && (
                                <Stack spacing={0} position="relative">
                                    <Text color="whiteAlpha.500" fontSize="sm" fontFamily="mono">
                                        Unstaking
                                    </Text>
                                    <Text color="orange.300" fontSize="lg" fontWeight="bold" fontFamily="'Neon Tubes', mono">
                                        {unstakingAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                    </Text>
                                    <Text
                                        color="whiteAlpha.400"
                                        fontSize="xs"
                                        fontFamily="mono"
                                        position="absolute"
                                        top="100%"
                                        left={0}
                                        whiteSpace="nowrap"
                                    >
                                        {unstakeHoursLeft}h left
                                    </Text>
                                </Stack>
                            )}
                        </HStack>
                        <Button
                            size="xs"
                            variant="outline"
                            w="17%"
                            minW="48px"
                            borderColor={`rgba(${r}, ${g}, ${b}, 0.5)`}
                            color={slotColor}
                            fontFamily="mono"
                            fontSize="xs"
                            _hover={{
                                bg: `rgba(${r}, ${g}, ${b}, 0.15)`,
                                borderColor: slotColor,
                            }}
                            onClick={(e) => {
                                e.stopPropagation()
                                setManageSlot(slot)
                            }}
                        >
                            Manage
                        </Button>
                    </HStack>
                </Box>
            </Collapse>
        </Box>
    )
}
