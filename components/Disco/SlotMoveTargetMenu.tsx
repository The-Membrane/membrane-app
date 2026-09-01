import React from 'react'
import { Box, HStack, Text, Button, Menu, MenuButton, MenuList, MenuItem } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { getSlotLabel } from './types'
import { getSlotRGB } from './SlotManageHelpers'

interface SlotMoveTargetMenuProps {
    targetSlot: number | null
    setTargetSlot: React.Dispatch<React.SetStateAction<number | null>>
    moveTargets: number[]
}

// Move tab: target slot selection menu.
export const SlotMoveTargetMenu: React.FC<SlotMoveTargetMenuProps> = ({
    targetSlot,
    setTargetSlot,
    moveTargets,
}) => {
    return (
        <Box>
            <Text color="whiteAlpha.600" fontSize="xs" fontFamily="mono" mb={2}>
                Move to slot
            </Text>
            <Menu>
                <MenuButton
                    as={Button}
                    size="md"
                    rightIcon={<ChevronDownIcon />}
                    w="100%"
                    h="44px"
                    bg={targetSlot
                        ? `rgba(${getSlotRGB(targetSlot).r}, ${getSlotRGB(targetSlot).g}, ${getSlotRGB(targetSlot).b}, 0.15)`
                        : 'rgba(0, 0, 0, 0.3)'}
                    border="1px solid"
                    borderColor={targetSlot
                        ? `rgba(${getSlotRGB(targetSlot).r}, ${getSlotRGB(targetSlot).g}, ${getSlotRGB(targetSlot).b}, 0.5)`
                        : 'whiteAlpha.200'}
                    color={targetSlot
                        ? `rgb(${getSlotRGB(targetSlot).r}, ${getSlotRGB(targetSlot).g}, ${getSlotRGB(targetSlot).b})`
                        : 'whiteAlpha.500'}
                    fontFamily="mono"
                    fontSize="md"
                    fontWeight="bold"
                    textAlign="left"
                    _hover={{ bg: targetSlot
                        ? `rgba(${getSlotRGB(targetSlot).r}, ${getSlotRGB(targetSlot).g}, ${getSlotRGB(targetSlot).b}, 0.25)`
                        : 'whiteAlpha.100' }}
                    _active={{ bg: 'whiteAlpha.100' }}
                >
                    {targetSlot
                        ? `Slot ${getSlotLabel(targetSlot)}`
                        : 'Select slot'}
                </MenuButton>
                <MenuList
                    bg="rgba(10, 10, 10, 0.98)"
                    borderColor="whiteAlpha.200"
                    py={2}
                >
                    {moveTargets.map((s) => {
                        const { r: sr, g: sg, b: sb } = getSlotRGB(s)
                        return (
                            <MenuItem
                                key={s}
                                bg="transparent"
                                py={2}
                                _hover={{ bg: `rgba(${sr}, ${sg}, ${sb}, 0.15)` }}
                                onClick={() => setTargetSlot(s)}
                            >
                                <HStack spacing={3}>
                                    <Box
                                        w="10px"
                                        h="10px"
                                        borderRadius="full"
                                        bg={`rgb(${sr}, ${sg}, ${sb})`}
                                        boxShadow={`0 0 6px rgba(${sr}, ${sg}, ${sb}, 0.6)`}
                                    />
                                    <Text color="white" fontSize="md" fontFamily="mono" fontWeight="bold">
                                        Slot {getSlotLabel(s)}
                                    </Text>
                                </HStack>
                            </MenuItem>
                        )
                    })}
                </MenuList>
            </Menu>
        </Box>
    )
}
