import React, { useMemo } from 'react'
import {
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    VStack,
    HStack,
    Box,
    Text,
    Button,
    NumberInput,
    NumberInputField,
    Stack,
} from '@chakra-ui/react'
import { getSlotLabel } from './types'
import type { SlotData } from './types'
import { shiftDigits } from '@/helpers/math'
import { riskRgbForLtv as getSlotRGB } from './riskRamp'

const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

// Format ordinal number (1st, 2nd, 3rd, etc.)
const formatOrdinal = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd']
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
}


interface DepositModalProps {
    isOpen: boolean
    onClose: () => void
    slot: number
    apr?: string | null
    walletBalance: string
    depositAmount: string
    onDepositAmountChange: (val: string) => void
    onDeposit: () => void
    isLoading?: boolean
    isDisabled?: boolean
    slotsData?: SlotData[]
}

export const DepositModal: React.FC<DepositModalProps> = ({
    isOpen,
    onClose,
    slot,
    apr,
    walletBalance,
    depositAmount,
    onDepositAmountChange,
    onDeposit,
    isLoading,
    isDisabled,
    slotsData,
}) => {
    const { r, g, b } = getSlotRGB(slot)
    const slotColor = `rgb(${r}, ${g}, ${b})`

    const handleClose = () => {
        onDepositAmountChange('')
        onClose()
    }

    // Loss Absorption Order + MBRN Defense Ahead
    const lossAbsorptionData = useMemo(() => {
        const position = slot
        let mbrnAhead = 0
        if (slotsData && slotsData.length > 0) {
            mbrnAhead = slotsData
                .filter(s => s.slot > slot && s.tvl > 0)
                .reduce((sum, s) => sum + s.tvl, 0)
        }
        return { position, mbrnAhead }
    }, [slot, slotsData])

    return (
        <Modal isOpen={isOpen} onClose={handleClose} size="md" isCentered>
            <ModalOverlay bg="blackAlpha.800" />
            <ModalContent
                bg="rgba(10, 10, 10, 0.95)"
                border="1px solid"
                borderColor={`rgba(${r}, ${g}, ${b}, 0.4)`}
                borderRadius="lg"
            >
                <ModalHeader pb={2}>
                    <HStack spacing={3}>
                        <Box
                            w="10px"
                            h="10px"
                            borderRadius="full"
                            bg={slotColor}
                            boxShadow={`0 0 8px ${slotColor}`}
                        />
                        <Text color="white" fontSize="lg" fontWeight="bold" fontFamily="mono">
                            Deposit — Slot {getSlotLabel(slot)}
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalCloseButton color="whiteAlpha.600" _hover={{ color: 'white' }} />

                <ModalBody pb={6}>
                    <VStack spacing={4} align="stretch">
                        {/* Amount input */}
                        <Box
                            bg="rgba(0, 0, 0, 0.3)"
                            borderRadius="md"
                            p={4}
                            border="1px solid"
                            borderColor="whiteAlpha.200"
                        >
                            <VStack spacing={4} align="stretch">
                                <Box>
                                    <HStack justify="space-between" mb={2}>
                                        <Text color="whiteAlpha.600" fontSize="xs" fontFamily="mono">
                                            MBRN to deposit
                                        </Text>
                                        <Text
                                            color={PRIMARY_PURPLE}
                                            fontSize="xs"
                                            fontFamily="mono"
                                            cursor="pointer"
                                            _hover={{ color: 'rgb(186, 166, 255)', textDecoration: 'underline' }}
                                            onClick={() => onDepositAmountChange(walletBalance)}
                                        >
                                            Wallet: {parseFloat(walletBalance || '0').toLocaleString('en-US')}
                                        </Text>
                                    </HStack>

                                    <NumberInput
                                        value={depositAmount}
                                        onChange={(val) => onDepositAmountChange(val)}
                                        min={0}
                                        max={parseFloat(walletBalance || '0')}
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

                                {/* Deposit button */}
                                <Button
                                    size="lg"
                                    bg={`rgba(${r}, ${g}, ${b}, 0.2)`}
                                    border="1px solid"
                                    borderColor={slotColor}
                                    color={slotColor}
                                    fontFamily="mono"
                                    fontWeight="bold"
                                    fontSize="sm"
                                    _hover={{
                                        bg: `rgba(${r}, ${g}, ${b}, 0.3)`,
                                    }}
                                    isDisabled={isDisabled || !depositAmount || parseFloat(depositAmount) <= 0}
                                    isLoading={isLoading}
                                    onClick={onDeposit}
                                >
                                    Deposit to Slot {getSlotLabel(slot)}
                                </Button>

                                {/* Slot Details Stats */}
                                <HStack spacing={0} justify="space-around" pt={2}>
                                    <Stack spacing={0} align="center">
                                        <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                                            Loss Absorption
                                        </Text>
                                        <Text
                                            fontSize="md"
                                            fontWeight="bold"
                                            color={slot === 1 ? "red.400" : "white"}
                                            fontFamily="'Neon Tubes', mono"
                                        >
                                            {formatOrdinal(lossAbsorptionData.position)} Loss
                                        </Text>
                                    </Stack>
                                    <Stack spacing={0} align="center">
                                        <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                                            Est. APR
                                        </Text>
                                        <Text
                                            fontSize="md"
                                            fontWeight="bold"
                                            color={apr ? "secondary.400" : "whiteAlpha.500"}
                                            fontFamily="'Neon Tubes', mono"
                                        >
                                            {apr || 'N/A'}
                                        </Text>
                                    </Stack>
                                    <Stack spacing={0} align="center">
                                        <Text color="whiteAlpha.500" fontSize="xs" fontFamily="mono">
                                            MBRN Defense
                                        </Text>
                                        <Text
                                            fontSize="md"
                                            fontWeight="bold"
                                            color="white"
                                            fontFamily="'Neon Tubes', mono"
                                        >
                                            {parseFloat(shiftDigits(lossAbsorptionData.mbrnAhead.toString(), -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                                        </Text>
                                    </Stack>
                                </HStack>
                            </VStack>
                        </Box>
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    )
}
