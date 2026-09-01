import React from 'react'
import { VStack, Text, Button } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import useAcquisitionDeposit from './hooks/useAcquisitionDeposit'

interface AcquisitionVisualizerLockButtonProps {
    depositAmount: number
    lockDays: number
    lockHook: ReturnType<typeof useAcquisitionDeposit>
    handleLock: () => void
}

export const AcquisitionVisualizerLockButton: React.FC<AcquisitionVisualizerLockButtonProps> = ({
    depositAmount,
    lockDays,
    lockHook,
    handleLock,
}) => {
    return (
        <VStack mt={8} spacing={2}>
            <Button
                size="lg"
                colorScheme="primary"
                fontFamily="mono"
                fontWeight="bold"
                px={12}
                py={6}
                fontSize="lg"
                borderRadius={0}
                isLoading={lockHook.action?.tx?.isPending}
                isDisabled={!lockHook.action?.simulate?.data || depositAmount <= 0}
                onClick={handleLock}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.press}
                _focus={FOCUS_STYLES.ring}
            >
                Lock {depositAmount.toLocaleString()} USDC for {lockDays} Days
            </Button>
            {!lockHook.action?.simulate?.data && depositAmount > 0 && (
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">
                    Preparing transaction...
                </Text>
            )}
        </VStack>
    )
}
