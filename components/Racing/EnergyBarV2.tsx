import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
    Box,
    HStack,
    IconButton,
    Progress,
    Text,
    VStack,
    useBreakpointValue,
    Button,
    Tooltip,
    Spinner
} from '@chakra-ui/react'
import { AddIcon, ChevronDownIcon } from '@chakra-ui/icons'
import useAppState from '@/persisted-state/useAppState'
import { useCarEnergy } from '@/services/q-racing'
import useRacingState from './hooks/useRacingState'
import { usePaymentSelection } from './hooks/usePaymentSelection'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import { useLongPress } from '@/helpers/useLongPress'
import useRefillEnergy from './hooks/useRefillEnergy'

// Simple lightning icon using SVG
const LightningIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <Box as="span" display="inline-block" w={`${size}px`} h={`${size}px`} mr={2}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="#7CFF00" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
    </Box>
)

export type EnergyBarV2Props = {
    tokenId?: string
    inline?: boolean
}

const formatDuration = (ms: number) => {
    if (ms <= 0) return 'Full'
    const totalSeconds = Math.floor(ms / 1000)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
}

const EnergyBarV2: React.FC<EnergyBarV2Props> = ({ tokenId, inline }) => {
    const { appState } = useAppState()
    const { data } = useCarEnergy(tokenId, appState.rpcUrl)
    const { racingState, setRacingState } = useRacingState()
    const isMobile = useBreakpointValue({ base: true, md: false })
    const lightningIconSize = useBreakpointValue({ base: 16, sm: 20, md: 30 })

    // Create refill energy hook for free refills
    const freeRefillHook = useRefillEnergy({ tokenId, paymentOption: null })

    // Create refill energy hook for paid refills (will be updated when option selected)
    const [currentPaymentOption, setCurrentPaymentOption] = useState<any>(null)
    const paidRefillHook = useRefillEnergy({ tokenId, paymentOption: currentPaymentOption })

    const {
        isOptionsOpen,
        isLoading,
        statusMessage,
        lastUsedPaymentMethod,
        paymentOptions,
        openOptions,
        closeOptions,
        executePayment,
        quickRefill
    } = usePaymentSelection(tokenId)



    useMemo(() => {
        if (data) {
            setRacingState({ energy: data.current_energy })
        }
    }, [data])

    const pct = useMemo(() => {
        if (!data) return 0
        if (data.max_energy === 0) return 0
        return Math.min(100, Math.round((racingState.energy / data.max_energy) * 100))
    }, [data])

    const timeToFull = useMemo(() => {
        if (!data) return 0
        const missing = Math.max(0, data.max_energy - racingState.energy)
        if (missing === 0 || data.energy_recovery_hours === 0) return 0
        const fullMs = data.energy_recovery_hours * 60 * 60 * 1000
        return Math.ceil((missing / data.max_energy) * fullMs)
    }, [data])

    // Long press handler for mobile
    const longPressRef = useLongPress({
        onLongPress: () => {
            if (isMobile) {
                openOptions()
            }
        },
        threshold: 500
    })

    const handleQuickRefill = () => {
        // This function is no longer used since we only open the menu
        // All execution happens in handleOptionSelect
    }

    const handleOptionSelect = (option: any) => {
        if (option.denom && option.amount !== '0') {
            // Paid option
            setCurrentPaymentOption({
                denom: option.denom,
                amount: option.amount
            })
            executePayment(option, () => paidRefillHook.action.tx.mutate())
        } else {
            // Free option
            executePayment(option, () => freeRefillHook.action.tx.mutate())
        }
    }

    // Desktop single button with dropdown
    if (!isMobile) {
        return (
            <HStack
                spacing={3}
                position="relative"
                top={inline ? undefined : 3}
                right={inline ? undefined : 3}
                bg="#0a0f1e"
                border="2px solid #0033ff"
                px={3}
                py={2}
                borderRadius="md"
                maxW={{ base: '100vw', md: 'auto' }}
                overflow="visible"
            >
                <LightningIcon size={lightningIconSize} />
                <VStack align="start" spacing={0} minW={{ base: '140px', md: '180px' }} maxW={{ base: '60vw', md: 'auto' }}>
                    <Text
                        fontSize={{ base: '8px', md: '10px' }}
                        fontFamily='"Press Start 2P", monospace'
                        color={racingState.energyColor}
                        mb={1}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                    >
                        {data ? `${racingState.energy} / ${data.max_energy}` : '0 / 0'}
                    </Text>
                    <HStack w="100%" spacing={2}>
                        <Progress
                            value={pct}
                            flex={1}
                            size="sm"
                            colorScheme="teal"
                            bg="#1b2338"
                            borderRadius="sm"
                        />
                        <Text
                            fontSize={{ base: '10px', md: '12px' }}
                            fontFamily='"Press Start 2P", monospace'
                            color="#b8c1ff"
                            minW="fit-content"
                        >
                            {pct}%
                        </Text>
                    </HStack>
                    <Text
                        fontSize={{ base: '8px', md: '10px' }}
                        fontFamily='"Press Start 2P", monospace'
                        color="#7cffa0"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                    >
                        {formatDuration(timeToFull)}
                    </Text>
                    {statusMessage && (
                        <Text
                            fontSize={{ base: '8px', md: '10px' }}
                            fontFamily='"Press Start 2P", monospace'
                            color="#7cffa0"
                            overflow="hidden"
                            textOverflow="ellipsis"
                            whiteSpace="nowrap"
                        >
                            {statusMessage}
                        </Text>
                    )}
                </VStack>

                {/* Single Button */}
                <Button
                    leftIcon={isLoading ? <Spinner size="sm" /> : <AddIcon />}
                    rightIcon={<ChevronDownIcon />}
                    onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openOptions()
                    }}
                    disabled={isLoading}
                    title={`isLoading: ${isLoading}, isOptionsOpen: ${isOptionsOpen}`}
                    bg="#274bff"
                    color="white"
                    _hover={{ bg: '#1a3bff' }}
                    _active={{ bg: '#0f2bff' }}
                    borderRadius="md"
                    size="sm"
                    minW="100px"
                    aria-label="Quick refill energy"
                    onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        openOptions()
                    }}
                >
                    {isLoading ? 'Refilling...' : 'Refill'}
                </Button>

                {/* Payment Options Sheet - positioned relative to entire HStack */}
                <PaymentOptionsSheet
                    isOpen={isOptionsOpen}
                    onClose={closeOptions}
                    paymentOptions={paymentOptions}
                    onSelectOption={handleOptionSelect}
                    isLoading={isLoading}
                    lastUsedPaymentMethod={lastUsedPaymentMethod}
                    dropdownWidth="full"
                    getActionForOption={(option) => {
                        if (option.denom && option.amount !== '0') {
                            return paidRefillHook.action
                        } else {
                            return freeRefillHook.action
                        }
                    }}
                />
            </HStack>
        )
    }

    // Mobile single button with long press
    return (
        <HStack
            spacing={{ base: 2, sm: 3 }}
            position={inline ? 'relative' : 'absolute'}
            top={inline ? undefined : 3}
            right={inline ? undefined : 3}
            bg="#0a0f1e"
            border="2px solid #0033ff"
            px={{ base: 2, sm: 3 }}
            py={{ base: 1, sm: 2 }}
            borderRadius="md"
            maxW={{ base: '100vw', sm: 'auto' }}
            overflow="hidden"
            justify={{ base: 'center', sm: 'flex-start' }}
            align={{ base: 'center', sm: 'flex-start' }}
        >
            <LightningIcon size={lightningIconSize} />
            <VStack align={{ base: 'center', sm: 'start' }} spacing={0} minW={{ base: '140px', sm: '180px' }} maxW={{ base: '60vw', sm: 'auto' }}>
                <Text
                    fontSize={{ base: '8px', sm: '10px' }}
                    fontFamily='"Press Start 2P", monospace'
                    color={racingState.energyColor}
                    mb={1}
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    textAlign={{ base: 'center', sm: 'left' }}
                >
                    {data ? `${racingState.energy} / ${data.max_energy}` : '0 / 0'}
                </Text>
                <HStack w="100%" spacing={{ base: 1, sm: 2 }}>
                    <Progress
                        value={pct}
                        flex={1}
                        size="sm"
                        colorScheme="teal"
                        bg="#1b2338"
                        borderRadius="sm"
                    />
                    <Text
                        fontSize={{ base: '10px', sm: '12px' }}
                        fontFamily='"Press Start 2P", monospace'
                        color="#b8c1ff"
                        minW="fit-content"
                    >
                        {pct}%
                    </Text>
                </HStack>
                <Text
                    fontSize={{ base: '8px', sm: '10px' }}
                    fontFamily='"Press Start 2P", monospace'
                    color="#7cffa0"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    textAlign={{ base: 'center', sm: 'left' }}
                >
                    {formatDuration(timeToFull)}
                </Text>
                {statusMessage && (
                    <Text
                        fontSize={{ base: '8px', sm: '10px' }}
                        fontFamily='"Press Start 2P", monospace'
                        color="#7cffa0"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                        textAlign={{ base: 'center', sm: 'left' }}
                    >
                        {statusMessage}
                    </Text>
                )}
            </VStack>

            {/* Mobile Single Button */}
            <Tooltip
                label="Tap to open payment options"
                placement="top"
                hasArrow
            >
                <IconButton
                    ref={longPressRef}
                    aria-label="Refill energy"
                    icon={isLoading ? <Spinner size="sm" /> : <AddIcon />}
                    onClick={openOptions}
                    disabled={isLoading}
                    width={{ base: "44px", sm: "30px" }}
                    height={{ base: "44px", sm: "30px" }}
                    variant="outline"
                    colorScheme="teal"
                    bg="#274bff"
                    color="white"
                    _hover={{ bg: '#1a3bff' }}
                    _active={{ bg: '#0f2bff' }}
                    minH={{ base: "44px", sm: "auto" }}
                    minW={{ base: "44px", sm: "auto" }}
                />
            </Tooltip>

            {/* Payment Options Sheet */}
            <PaymentOptionsSheet
                isOpen={isOptionsOpen}
                onClose={closeOptions}
                paymentOptions={paymentOptions}
                onSelectOption={handleOptionSelect}
                isLoading={isLoading}
                lastUsedPaymentMethod={lastUsedPaymentMethod}
                dropdownWidth="full"
                getActionForOption={(option) => {
                    if (option.denom && option.amount !== '0') {
                        return paidRefillHook.action
                    } else {
                        return freeRefillHook.action
                    }
                }}
            />
        </HStack>
    )
}

export default EnergyBarV2
