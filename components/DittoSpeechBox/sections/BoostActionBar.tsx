import React from 'react'
import { Box, HStack, Button } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'

interface BoostActionBarProps {
    hasSelection: boolean
    isLocked: boolean
    onDeposit: () => void
    onWithdraw: () => void
    onEditLock: () => void
}

export const BoostActionBar: React.FC<BoostActionBarProps> = ({
    hasSelection,
    isLocked,
    onDeposit,
    onWithdraw,
    onEditLock,
}) => {
    return (
        <Box
            position={hasSelection ? "fixed" : "absolute"}
            bottom={0}
            left={0}
            right={0}
            bg={SEMANTIC_COLORS.bgSecondary}
            borderTop="1px solid"
            borderColor={hasSelection ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.md}
            px={SPACING.xs}
            pb={hasSelection ? SPACING.md : SPACING.xs}
            transition={TRANSITIONS.colors}
            zIndex={10}
        >
            <HStack spacing={SPACING.sm} w="100%">
                <Button
                    size="sm"
                    variant="outline"
                    borderRadius={0}
                    borderColor={hasSelection ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderSubtle}
                    color={hasSelection ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textTertiary}
                    onClick={onDeposit}
                    isDisabled={!hasSelection}
                    transition={TRANSITIONS.colors}
                    _hover={hasSelection ? { borderColor: SEMANTIC_COLORS.primary } : {}}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                >
                    Deposit
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    borderRadius={0}
                    borderColor={hasSelection && !isLocked ? SEMANTIC_COLORS.secondary : SEMANTIC_COLORS.borderSubtle}
                    color={hasSelection && !isLocked ? SEMANTIC_COLORS.secondary : SEMANTIC_COLORS.textTertiary}
                    onClick={onWithdraw}
                    isDisabled={!hasSelection || isLocked}
                    transition={TRANSITIONS.colors}
                    _hover={hasSelection && !isLocked ? { borderColor: SEMANTIC_COLORS.secondary } : {}}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ringCyan}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                    title={isLocked ? 'Cannot withdraw locked deposits' : ''}
                >
                    Withdraw
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    borderRadius={0}
                    borderColor={hasSelection ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.borderSubtle}
                    color={hasSelection ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary}
                    onClick={onEditLock}
                    isDisabled={!hasSelection}
                    transition={TRANSITIONS.colors}
                    _hover={hasSelection ? { borderColor: SEMANTIC_COLORS.warning } : {}}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                >
                    Extend
                </Button>
            </HStack>
        </Box>
    )
}
