import React from 'react'
import { Box, HStack, Button } from '@chakra-ui/react'

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
            bg="#23252B"
            borderTop="1px solid"
            borderColor={hasSelection ? '#9F7AEA' : '#9bdc4f30'}
            pt={3}
            px={1}
            pb={hasSelection ? 3 : 1}
            transition="all 0.25s cubic-bezier(0.4, 0, 0.2, 1)"
            boxShadow={hasSelection ? '0 -4px 20px rgba(159, 122, 234, 0.3)' : 'none'}
            zIndex={10}
        >
            <HStack spacing={2} w="100%">
                <Button
                    size="sm"
                    variant="outline"
                    borderColor={hasSelection ? 'primary.400' : '#9bdc4f30'}
                    color={hasSelection ? 'primary.300' : '#ece6d850'}
                    onClick={onDeposit}
                    isDisabled={!hasSelection}
                    _hover={hasSelection ? {
                        bg: '#9bdc4f20',
                        boxShadow: '0 0 10px rgba(159, 122, 234, 0.3)',
                    } : {}}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                    transition="all 0.2s"
                >
                    Deposit
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    borderColor={hasSelection && !isLocked ? 'secondary.400' : '#9bdc4f30'}
                    color={hasSelection && !isLocked ? 'secondary.300' : '#ece6d850'}
                    onClick={onWithdraw}
                    isDisabled={!hasSelection || isLocked}
                    _hover={hasSelection && !isLocked ? {
                        bg: '#38B2AC20',
                        boxShadow: '0 0 10px rgba(56, 178, 172, 0.3)',
                    } : {}}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                    transition="all 0.2s"
                    title={isLocked ? 'Cannot withdraw locked deposits' : ''}
                >
                    Withdraw
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    borderColor={hasSelection ? 'blue.400' : '#9bdc4f30'}
                    color={hasSelection ? 'blue.300' : '#ece6d850'}
                    onClick={onEditLock}
                    isDisabled={!hasSelection}
                    _hover={hasSelection ? {
                        bg: '#4299E120',
                        boxShadow: '0 0 10px rgba(66, 153, 225, 0.3)',
                    } : {}}
                    _disabled={{
                        opacity: 0.5,
                        cursor: 'not-allowed',
                    }}
                    flex={1}
                    transition="all 0.2s"
                >
                    Extend
                </Button>
            </HStack>
        </Box>
    )
}
