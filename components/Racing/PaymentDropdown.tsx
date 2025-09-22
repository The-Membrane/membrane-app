import React, { useState, useRef, useEffect } from 'react'
import { Box, HStack, IconButton, Text, VStack, Menu, MenuButton, MenuList, MenuOptionGroup, MenuItemOption } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import ConfirmModal from '@/components/ConfirmModal'
import { PaymentOption } from './hooks/usePaymentSelection'

export interface PaymentDropdownProps {
    paymentOptions: PaymentOption[]
    onSelectOption: (option: PaymentOption) => void
    selectedOption: PaymentOption | null
    setSelectedOption: (option: PaymentOption | null) => void
    action: any // The useQuery action to execute
    buttonText: string
    buttonProps?: any
    isLoading?: boolean
}

const PaymentDropdown: React.FC<PaymentDropdownProps> = ({
    paymentOptions,
    onSelectOption,
    selectedOption,
    setSelectedOption,
    action,
    buttonText,
    buttonProps = {},
    isLoading = false
}) => {
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const openedAtRef = useRef<number | null>(null)
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const MIN_OPEN_MS = 700

    const openMenu = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
        openedAtRef.current = Date.now()
        setIsMenuOpen(true)
    }

    const handleMouseLeave = () => {
        const openedAt = openedAtRef.current
        const now = Date.now()
        const elapsed = openedAt ? now - openedAt : MIN_OPEN_MS
        const remaining = Math.max(0, MIN_OPEN_MS - elapsed)
        if (remaining === 0) {
            setIsMenuOpen(false)
        } else {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
            closeTimerRef.current = setTimeout(() => {
                setIsMenuOpen(false)
                closeTimerRef.current = null
            }, remaining)
        }
    }

    const immediateCloseMenu = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
        setIsMenuOpen(false)
    }

    useEffect(() => () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }, [])

    const handleOptionChange = (val: string) => {
        if (val === 'free') {
            setSelectedOption(null)
        } else {
            const [denom, amount] = val.split(':')
            const option = paymentOptions.find(opt => opt.denom === denom && opt.amount === amount)
            if (option) {
                setSelectedOption(option)
            }
        }
    }

    const getSelectedValue = () => {
        if (!selectedOption) return 'free'
        return `${selectedOption.denom}:${selectedOption.amount}`
    }

    return (
        <Box position="relative">
            <Menu isOpen={isMenuOpen} onOpen={openMenu} onClose={immediateCloseMenu} placement="bottom">
                <MenuButton as={Box} position="relative">
                    <ConfirmModal
                        label={buttonText}
                        executeDirectly={true}
                        action={action}
                        onClick={immediateCloseMenu}
                        buttonProps={{
                            rightIcon: <ChevronDownIcon />,
                            isLoading,
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: "12px",
                            bg: "#274bff",
                            color: "white",
                            _hover: { bg: '#1a3bff' },
                            _active: { bg: '#0f2bff' },
                            borderRadius: "md",
                            size: "sm",
                            ...buttonProps
                        }}
                    >
                        <VStack align="start" spacing={1}>
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#e6e6e6">
                                Confirm {buttonText.toLowerCase()}
                            </Text>
                            {selectedOption ? (
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                    Pay {selectedOption.amount} {selectedOption.denom}
                                </Text>
                            ) : (
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                    Free option
                                </Text>
                            )}
                        </VStack>
                    </ConfirmModal>
                </MenuButton>

                <MenuList
                    minW="240px"
                    bg="#0b0e17"
                    borderColor="#2a3550"
                    px={1}
                    onMouseEnter={openMenu}
                    onMouseLeave={handleMouseLeave}
                >
                    {paymentOptions.length > 0 ? (
                        <MenuOptionGroup
                            type='radio'
                            title='Payment'
                            value={getSelectedValue()}
                            onChange={handleOptionChange}
                        >
                            {paymentOptions.map((opt, idx) => (
                                <MenuItemOption key={`${opt.denom}-${idx}`} value={`${opt.denom}:${opt.amount}`}>
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                        Pay {opt.amount} {opt.denom}
                                    </Text>
                                </MenuItemOption>
                            ))}
                            <MenuItemOption value='free'>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                    Free option
                                </Text>
                            </MenuItemOption>
                        </MenuOptionGroup>
                    ) : (
                        <MenuOptionGroup type='radio' value='free'>
                            <MenuItemOption value='free'>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                    Free option
                                </Text>
                            </MenuItemOption>
                        </MenuOptionGroup>
                    )}
                </MenuList>
            </Menu>
        </Box>
    )
}

export default PaymentDropdown
