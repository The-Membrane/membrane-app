import React from 'react'
import { Box, VStack, HStack, Text, Button, NumberInput, NumberInputField } from '@chakra-ui/react'
import { getSlotLabel } from './types'
import type { Tab, SlotData } from './SlotManageHelpers'
import { SlotMoveTargetMenu } from './SlotMoveTargetMenu'

type DepositHook = ReturnType<typeof import('./hooks/useDiscoDeposit').default>
type UnstakeHook = ReturnType<typeof import('./hooks/useDiscoUnstake').default>
type MoveHook = ReturnType<typeof import('./hooks/useDiscoMoveDeposit').default>

interface SlotManageTabContentProps {
    activeTab: Tab
    amount: string
    setAmount: React.Dispatch<React.SetStateAction<string>>
    targetSlot: number | null
    setTargetSlot: React.Dispatch<React.SetStateAction<number | null>>
    slot: number
    slotData: SlotData
    moveTargets: number[]
    r: number
    g: number
    b: number
    slotColor: string
    depositHook: DepositHook
    unstakeHook: UnstakeHook
    moveHook: MoveHook
    unstakingAmount: number
    isLiquidationLockout: boolean
    unstakeHoursLeft: number
}

// Tab content panel: amount input, move-target menu, withdraw info, action button, unstaking indicator.
export const SlotManageTabContent: React.FC<SlotManageTabContentProps> = ({
    activeTab,
    amount,
    setAmount,
    targetSlot,
    setTargetSlot,
    slot,
    slotData,
    moveTargets,
    r,
    g,
    b,
    slotColor,
    depositHook,
    unstakeHook,
    moveHook,
    unstakingAmount,
    isLiquidationLockout,
    unstakeHoursLeft,
}) => {
    return (
        <Box
            bg="rgba(0, 0, 0, 0.3)"
            borderRadius="md"
            p={4}
            border="1px solid"
            borderColor="whiteAlpha.200"
        >
            <VStack spacing={4} align="stretch">
                {/* Amount input (all tabs) */}
                <Box>
                    <HStack justify="space-between" mb={2}>
                        <Text color="whiteAlpha.600" fontSize="xs" fontFamily="mono">
                            {activeTab === 'deposit' ? 'MBRN to deposit' : activeTab === 'withdraw' ? 'MBRN to withdraw' : 'MBRN to move'}
                        </Text>
                        {activeTab === 'withdraw' && slotData.amount > 0 && (
                            <Button
                                size="xs"
                                variant="outline"
                                borderColor={`rgba(${r}, ${g}, ${b}, 0.4)`}
                                color={slotColor}
                                fontFamily="mono"
                                fontSize="xs"
                                _hover={{ bg: `rgba(${r}, ${g}, ${b}, 0.1)` }}
                                onClick={() => setAmount(slotData.amount.toString())}
                            >
                                MAX
                            </Button>
                        )}
                        {activeTab === 'move' && slotData.amount > 0 && (
                            <Button
                                size="xs"
                                variant="outline"
                                borderColor={`rgba(${r}, ${g}, ${b}, 0.4)`}
                                color={slotColor}
                                fontFamily="mono"
                                fontSize="xs"
                                _hover={{ bg: `rgba(${r}, ${g}, ${b}, 0.1)` }}
                                onClick={() => setAmount(slotData.amount.toString())}
                            >
                                MAX
                            </Button>
                        )}
                    </HStack>

                    <NumberInput
                        value={amount}
                        onChange={(val) => setAmount(val)}
                        min={0}
                    >
                        <NumberInputField
                            placeholder="0"
                            bg="rgba(0, 0, 0, 0.3)"
                            borderColor="whiteAlpha.200"
                            color="white"
                            fontSize="xl"
                            fontWeight="bold"
                            fontFamily="'Neon Tubes', mono"
                            textAlign="right"
                            _focus={{ borderColor: slotColor, boxShadow: `0 0 0 1px ${slotColor}` }}
                        />
                    </NumberInput>
                </Box>

                {/* Move tab: target slot menu */}
                {activeTab === 'move' && (
                    <SlotMoveTargetMenu
                        targetSlot={targetSlot}
                        setTargetSlot={setTargetSlot}
                        moveTargets={moveTargets}
                    />
                )}

                {/* Withdraw info */}
                {activeTab === 'withdraw' && (
                    <Text color="whiteAlpha.400" fontSize="xs" fontFamily="mono">
                        Unstaking starts a 2-day cooldown. The cooldown extends to 2 days after the last liquidation event for this asset.
                    </Text>
                )}

                {/* Action button */}
                <Button
                    size="lg"
                    bg={activeTab === 'withdraw' ? 'rgba(239, 68, 68, 0.2)' : `rgba(${r}, ${g}, ${b}, 0.2)`}
                    border="1px solid"
                    borderColor={activeTab === 'withdraw' ? 'red.400' : slotColor}
                    color={activeTab === 'withdraw' ? 'red.300' : slotColor}
                    fontFamily="mono"
                    fontWeight="bold"
                    fontSize="sm"
                    _hover={{
                        bg: activeTab === 'withdraw' ? 'rgba(239, 68, 68, 0.3)' : `rgba(${r}, ${g}, ${b}, 0.3)`,
                    }}
                    isDisabled={
                        !amount || parseFloat(amount) <= 0 ||
                        (activeTab === 'move' && targetSlot === null) ||
                        (activeTab === 'deposit' && !depositHook.action?.simulate?.isSuccess) ||
                        (activeTab === 'withdraw' && !unstakeHook.action?.simulate?.isSuccess) ||
                        (activeTab === 'move' && !moveHook.action?.simulate?.isSuccess)
                    }
                    isLoading={
                        (activeTab === 'deposit' && (depositHook.action?.simulate?.isLoading || depositHook.action?.tx?.isPending)) ||
                        (activeTab === 'withdraw' && (unstakeHook.action?.simulate?.isLoading || unstakeHook.action?.tx?.isPending)) ||
                        (activeTab === 'move' && (moveHook.action?.simulate?.isLoading || moveHook.action?.tx?.isPending)) ||
                        false
                    }
                    onClick={async () => {
                        if (activeTab === 'deposit') {
                            await depositHook.action?.tx?.mutateAsync()
                        } else if (activeTab === 'withdraw') {
                            await unstakeHook.action?.tx?.mutateAsync()
                        } else if (activeTab === 'move') {
                            await moveHook.action?.tx?.mutateAsync()
                        }
                    }}
                >
                    {activeTab === 'deposit' && `Deposit to Slot ${getSlotLabel(slot)}`}
                    {activeTab === 'withdraw' && `Request Unstake`}
                    {activeTab === 'move' && `Move to Slot ${targetSlot ? getSlotLabel(targetSlot) : '?'}`}
                </Button>

                {/* Currently unstaking indicator - withdraw tab only */}
                {activeTab === 'withdraw' && unstakingAmount > 0 && (
                    <VStack spacing={0} align="center" pt={1}>
                        <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                            Currently unstaking
                        </Text>
                        <Text color="orange.300" fontSize="lg" fontWeight="bold" fontFamily="'Neon Tubes', mono" position="relative">
                            {unstakingAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            <Text
                                as="span"
                                display="block"
                                color="whiteAlpha.400"
                                fontSize="xs"
                                fontFamily="mono"
                                fontWeight="normal"
                                position="absolute"
                                top="100%"
                                left="50%"
                                transform="translateX(-50%)"
                                whiteSpace="nowrap"
                            >
                                {isLiquidationLockout ? `Liq lockout · ${unstakeHoursLeft}h` : `${unstakeHoursLeft}h left`}
                            </Text>
                        </Text>
                    </VStack>
                )}
            </VStack>
        </Box>
    )
}
