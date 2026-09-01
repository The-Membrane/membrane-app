import React from 'react'
import {
    HStack,
    IconButton,
    Progress,
    Text,
    VStack,
    Tooltip,
    Spinner
} from '@chakra-ui/react'
import { Tooltip as GuidanceTooltip } from '@/components/Racing/Guidance'
import { AddIcon } from '@chakra-ui/icons'
import LightningIcon from './EnergyBarLightningIcon'
import PaymentOptionsSheet from './PaymentOptionsSheet'
import type { EnergyBarViewProps } from './hooks/useEnergyBarV2'

// Mobile single button with long press
const EnergyBarMobile: React.FC<EnergyBarViewProps> = ({
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
    longPressRef,
}) => {
    return (
        <GuidanceTooltip
            content="Energy powers your car in races. It regenerates over time or can be refilled manually. Keep an eye on your energy levels!"
            isVisible={false} // Set to true when you want to show tooltip
            position="left"
        >
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
                style={style}
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
                        {energyLabel}
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
                        {timeToFullLabel}
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
                    getActionForOption={getActionForOption}
                />
            </HStack>
        </GuidanceTooltip>
    )
}

export default EnergyBarMobile
