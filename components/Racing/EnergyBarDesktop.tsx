import React from 'react'
import {
    HStack,
    Progress,
    Text,
    VStack,
    Button,
    Spinner
} from '@chakra-ui/react'
import { AddIcon, ChevronDownIcon } from '@chakra-ui/icons'
import LightningIcon from './EnergyBarLightningIcon'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import type { EnergyBarViewProps } from './hooks/useEnergyBarV2'

// Desktop single button with dropdown
const EnergyBarDesktop: React.FC<EnergyBarViewProps> = ({
    inline,
    style,
    lightningIconSize,
    racingState,
    pct,
    energyLabel,
    timeToFullLabel,
    statusMessage,
    isLoading,
    isOptionsOpen,
    paymentOptions,
    lastUsedPaymentMethod,
    openOptions,
    closeOptions,
    handleOptionSelect,
    getActionForOption,
}) => {
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
            style={style}
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
                    {energyLabel}
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
                    {timeToFullLabel}
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
                getActionForOption={getActionForOption}
            />
        </HStack>
    )
}

export default EnergyBarDesktop
