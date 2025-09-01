import React, { useEffect, useRef } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    IconButton,
    Divider,
    useBreakpointValue,
    Modal,
    ModalOverlay,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalCloseButton,
    Drawer,
    DrawerOverlay,
    DrawerContent,
    DrawerHeader,
    DrawerBody,
    DrawerCloseButton,
    Button,
    Spinner,
    Tooltip
} from '@chakra-ui/react'
import { ChevronDownIcon, CloseIcon } from '@chakra-ui/icons'
import { PaymentOption } from './hooks/usePaymentSelection'
import ConfirmModal from '../ConfirmModal'

interface PaymentOptionsSheetProps {
    isOpen: boolean
    onClose: () => void
    paymentOptions: PaymentOption[]
    onSelectOption: (option: PaymentOption) => void
    isLoading: boolean
    lastUsedPaymentMethod?: { denom: string; amount: string } | null
    dropdownWidth?: 'full' | 'default'
    getActionForOption?: (option: PaymentOption) => any
}

const PaymentOptionsSheet: React.FC<PaymentOptionsSheetProps> = ({
    isOpen,
    onClose,
    paymentOptions,
    onSelectOption,
    isLoading,
    lastUsedPaymentMethod,
    dropdownWidth = 'default',
    getActionForOption
}) => {
    const isMobile = useBreakpointValue({ base: true, md: false })
    const dropdownRef = useRef<HTMLDivElement>(null)

    // Click outside handler for desktop dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                onClose()
            }
        }

        if (isOpen && !isMobile) {
            document.addEventListener('mousedown', handleClickOutside)
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [isOpen, isMobile, onClose])

    const handleOptionSelect = (option: PaymentOption) => {
        if (option.isAvailable && !isLoading) {
            onSelectOption(option)
            onClose()
        }
    }

    const renderOption = (option: PaymentOption, index: number) => {
        const isLastUsed = lastUsedPaymentMethod &&
            option.denom === lastUsedPaymentMethod.denom &&
            option.amount === lastUsedPaymentMethod.amount

        const action = getActionForOption?.(option)

        return (
            <Box
                key={`${option.denom}-${option.amount}-${index}`}
                w="100%"
                p={4}
                bg={option.isAvailable ? '#1a1f2e' : '#0f141f'}
                border="1px solid"
                borderColor={option.isAvailable ? '#2a3550' : '#1a1f2e'}
                borderRadius="lg"
                opacity={option.isAvailable ? 1 : 0.5}
                position="relative"
            >
                <VStack align="start" spacing={2}>
                    <HStack w="100%" justify="space-between">
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="12px"
                            color="#e6e6e6"
                            fontWeight="bold"
                        >
                            {option.label}
                        </Text>
                        {isLastUsed && (
                            <Text
                                fontFamily='"Press Start 2P", monospace'
                                fontSize="8px"
                                color="#7cffa0"
                                bg="#1a2f1a"
                                px={2}
                                py={1}
                                borderRadius="sm"
                            >
                                DEFAULT
                            </Text>
                        )}
                    </HStack>
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="10px"
                        color="#b8c1ff"
                    >
                        {option.sublabel}
                    </Text>

                    {/* Wallet Balance - always shown in low opacity */}
                    {option.formattedBalance && (
                        <Text
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="8px"
                            color="white"
                            opacity={0.6}
                        >
                            Wallet: {option.formattedBalance}
                        </Text>
                    )}

                    {/* ConfirmModal Button */}
                    <ConfirmModal
                        label={option.label}
                        action={action}
                        isDisabled={!option.isAvailable || isLoading}
                        isLoading={isLoading}
                        executeDirectly={true}
                        buttonProps={{
                            w: "100%",
                            bg: option.isAvailable ? '#274bff' : '#1a1f2e',
                            color: "white",
                            _hover: option.isAvailable ? { bg: '#1a3bff' } : {},
                            _active: option.isAvailable ? { bg: '#0f2bff' } : {},
                            borderRadius: "md",
                            size: "sm",
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: "10px",
                            minH: "32px",
                            cursor: option.isAvailable ? 'pointer' : 'not-allowed',
                        }}
                    />
                </VStack>
            </Box>
        )
    }

    // Mobile: Bottom Sheet
    if (isMobile) {
        return (
            <Drawer isOpen={isOpen} onClose={onClose} placement="bottom" size="full">
                <DrawerOverlay />
                <DrawerContent bg="#0b0e17" borderTopRadius="xl">
                    <DrawerHeader
                        borderBottom="1px solid #1d2333"
                        bg="#0f1422"
                        borderTopRadius="xl"
                    >
                        <HStack justify="space-between" align="center">
                            <Text
                                fontFamily='"Press Start 2P", monospace'
                                fontSize="16px"
                                color="#e6e6e6"
                            >
                                Payment
                            </Text>
                            <IconButton
                                aria-label="Close payment options"
                                icon={<CloseIcon />}
                                variant="ghost"
                                color="#b8c1ff"
                                onClick={onClose}
                                size="sm"
                            />
                        </HStack>
                        {/* Close handle */}
                        <Box
                            w="40px"
                            h="4px"
                            bg="#2a3550"
                            borderRadius="full"
                            mx="auto"
                            mt={2}
                        />
                    </DrawerHeader>
                    <DrawerBody p={4}>
                        <VStack spacing={3} align="stretch">
                            {paymentOptions.map((option, index) => (
                                <React.Fragment key={index}>
                                    {renderOption(option, index)}
                                    {index < paymentOptions.length - 1 && (
                                        <Divider borderColor="#1d2333" />
                                    )}
                                </React.Fragment>
                            ))}
                        </VStack>
                    </DrawerBody>
                </DrawerContent>
            </Drawer>
        )
    }

    // Desktop: Simple positioned dropdown
    return (
        <>
            {isOpen && (
                <Box
                    position="absolute"
                    top="100%"
                    left={dropdownWidth === 'full' ? "0" : "0"}
                    right="0"
                    mt={5}
                    bg="#0b0e17"
                    border="1px solid #2a3550"
                    borderRadius="md"
                    p={2}
                    zIndex={9999}
                    w={dropdownWidth === 'full' ? "100%" : "100%"}
                    minW={dropdownWidth === 'full' ? "100%" : "280px"}
                    boxShadow="0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)"
                    ref={dropdownRef}
                >
                    <VStack spacing={3} align="stretch">
                        {paymentOptions.map((option, index) => (
                            <React.Fragment key={index}>
                                {renderOption(option, index)}
                                {index < paymentOptions.length - 1 && (
                                    <Divider borderColor="#1d2333" />
                                )}
                            </React.Fragment>
                        ))}
                    </VStack>
                </Box>
            )}
        </>
    )
}

export default PaymentOptionsSheet

