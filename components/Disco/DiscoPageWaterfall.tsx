import React from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import { DiscoPageWaterfallRow } from './DiscoPageWaterfallRow'
import { PRIMARY_PURPLE } from './DiscoPageConstants'
import type { DiscoPageState } from './hooks/useDiscoPage'

interface DiscoPageWaterfallProps {
    depositCarouselData: DiscoPageState['depositCarouselData']
    userSlotDeposits: DiscoPageState['userSlotDeposits']
    unstakeData: DiscoPageState['unstakeData']
    bufferData: DiscoPageState['bufferData']
    expandedUserSlots: DiscoPageState['expandedUserSlots']
    setExpandedUserSlots: DiscoPageState['setExpandedUserSlots']
    setManageSlot: DiscoPageState['setManageSlot']
}

/** Right column of "Your Deposits": the per-slot deposits waterfall. */
export const DiscoPageWaterfall: React.FC<DiscoPageWaterfallProps> = ({
    depositCarouselData,
    userSlotDeposits,
    unstakeData,
    bufferData,
    expandedUserSlots,
    setExpandedUserSlots,
    setManageSlot,
}) => {
    if (depositCarouselData.length === 0) return null

    return (
        <Box
            bg="rgba(10, 10, 10, 0.8)"
            p={4}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
        >
            <VStack spacing={2} align="stretch" w="100%">
                <Text
                    fontSize="xs"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="mono"
                    letterSpacing="1px"
                    textTransform="uppercase"
                    mb={1}
                    textAlign="left"
                >
                    Your Waterfall
                </Text>

                <Box
                    maxH="450px"
                    overflowY="auto"
                    css={{
                        '&::-webkit-scrollbar': { width: '4px' },
                        '&::-webkit-scrollbar-track': { bg: 'transparent' },
                        '&::-webkit-scrollbar-thumb': { bg: 'rgba(155, 220, 79, 0.3)', borderRadius: '2px' },
                    }}
                >
                    <VStack spacing={2} align="stretch">
                        {userSlotDeposits.slots.map(({ slot, amount, claimable, apr }, idx) => (
                            <DiscoPageWaterfallRow
                                key={slot}
                                slot={slot}
                                amount={amount}
                                claimable={claimable}
                                apr={apr}
                                idx={idx}
                                userSlotDeposits={userSlotDeposits}
                                unstakeData={unstakeData}
                                bufferData={bufferData}
                                expandedUserSlots={expandedUserSlots}
                                setExpandedUserSlots={setExpandedUserSlots}
                                setManageSlot={setManageSlot}
                            />
                        ))}
                    </VStack>
                </Box>
            </VStack>
        </Box>
    )
}
