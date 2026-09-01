import React from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Button,
    Collapse,
    Divider,
    IconButton,
} from '@chakra-ui/react'
import { ChevronDownIcon, CloseIcon } from '@chakra-ui/icons'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { useDittoConfirmation } from '@/components/DittoSpeechBox/hooks/useDittoConfirmation'
import useAcquisitionClaimCard from './hooks/useAcquisitionClaimCard'
import { AcquisitionClaimIntentSelector } from './AcquisitionClaimIntentSelector'

interface AcquisitionClaimCardProps {
    claimableAmount: number
    onClaimSuccess?: () => void
}

// Check if mock data is enabled
const USE_MOCK_DATA = true // Should match services/acquisition.ts

export const AcquisitionClaimCard: React.FC<AcquisitionClaimCardProps> = ({
    claimableAmount,
    onClaimSuccess,
}) => {
    const { openConfirmation } = useDittoConfirmation()
    const {
        isOpen,
        onToggle,
        discoAssets,
        selectedIntentType,
        setSelectedIntentType,
        intents,
        setIntents,
        radioGroupRef,
        updateIntent,
        handleRadioChange,
        claimHook,
        isValid,
        effectiveClaimableAmount,
        isButtonDisabled,
        buttonLabel,
    } = useAcquisitionClaimCard({ claimableAmount, onClaimSuccess })

    const handleClaim = () => {
        if (!isValid || !claimHook.action?.simulate?.data) return

        const enabledIntents = intents.filter(i => i.enabled && i.ratio > 0)
        const displayAmount = effectiveClaimableAmount

        openConfirmation(
            claimHook.action,
            <VStack spacing={2} align="stretch" p={2}>
                <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary}>
                    Claiming {displayAmount.toFixed(2)} MBRN
                </Text>
                <Divider />
                {enabledIntents.map((intent, idx) => {
                    return (
                        <Box key={idx}>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                {intent.type === 'stake' && 'Stake'}
                                {intent.type === 'deposit' && 'Deposit to Disco'}
                                {intent.type === 'send' && 'Send to Address'}
                                : {intent.ratio.toFixed(1)}%
                            </Text>
                        </Box>
                    )
                })}
            </VStack>,
            { label: 'Claim', actionType: 'withdraw' }
        )
    }

    return (
        <VStack spacing={0} align="stretch" w="100%">
            {/* No claims message */}
            {!USE_MOCK_DATA && claimableAmount <= 0 && (
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} textAlign="center" mb={1}>
                    No claims available
                </Text>
            )}

            {/* Ready To Claim Button - only show when collapsed */}
            {!isOpen && (
                <Button
                    onClick={onToggle}
                    rightIcon={<ChevronDownIcon transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'} transition={TRANSITIONS.transformQuick} />}
                    size="md"
                    colorScheme="primary"
                    borderRadius={0}
                    isDisabled={isButtonDisabled}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.press}
                    _focus={FOCUS_STYLES.ring}
                >
                    {buttonLabel}
                </Button>
            )}

            {/* Expanded Intent Content */}
            <Collapse in={isOpen} animateOpacity>
                <VStack spacing={4} align="stretch" p={4} bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                    {/* Header with close icon */}
                    <HStack justify="space-between" align="center">
                        <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.primary}>
                            Boost your Claims
                        </Text>
                        <IconButton
                            aria-label="Close"
                            icon={<CloseIcon />}
                            size="sm"
                            width={"11%"}
                            variant="ghost"
                            onClick={onToggle}
                            colorScheme="gray"
                            borderRadius={0}
                            _focus={FOCUS_STYLES.ring}
                        />
                    </HStack>

                    {/* Radio Button Selection */}
                    <AcquisitionClaimIntentSelector
                        radioGroupRef={radioGroupRef}
                        selectedIntentType={selectedIntentType}
                        setSelectedIntentType={setSelectedIntentType}
                        handleRadioChange={handleRadioChange}
                        intents={intents}
                        setIntents={setIntents}
                        updateIntent={updateIntent}
                        discoAssets={discoAssets}
                    />

                    {/* Claim Button */}
                    <Button
                        onClick={handleClaim}
                        isDisabled={!isValid || !claimHook.action?.simulate?.data}
                        isLoading={claimHook.action?.tx?.isPending}
                        colorScheme="primary"
                        size="md"
                        borderRadius={0}
                        transition={TRANSITIONS.colors}
                        _hover={HOVER_EFFECTS.borderHighlight}
                        _active={ACTIVE_EFFECTS.press}
                        _focus={FOCUS_STYLES.ring}
                    >
                        Claim {effectiveClaimableAmount.toFixed(2)} MBRN
                    </Button>
                </VStack>
            </Collapse>
        </VStack>
    )
}
