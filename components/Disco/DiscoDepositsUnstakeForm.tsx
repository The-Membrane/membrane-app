import React from 'react'
import { VStack, Text, Box, HStack, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsUnstakeFormProps = Pick<
    DiscoDepositsData,
    'setShowUnstakeForm' | 'requestUnstakeHook' | 'handleRequestUnstake'
>

export const DiscoDepositsUnstakeForm: React.FC<DiscoDepositsUnstakeFormProps> = ({
    setShowUnstakeForm,
    requestUnstakeHook,
    handleRequestUnstake,
}) => {
    return (
        <Box mt={4}>
            <VStack spacing={3} align="stretch">
                <Text fontSize="sm" fontWeight="bold" color="red.400" fontFamily="mono" textTransform="uppercase">
                    Request Unstake
                </Text>
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono">
                    This will start a 2-day cooldown period. The cooldown extends to 2 days after the last liquidation event for this asset.
                </Text>
                <HStack spacing={2}>
                    <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderColor={`${PRIMARY_PURPLE}40`}
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="xs"
                        _hover={{ borderColor: PRIMARY_PURPLE, color: 'white' }}
                        onClick={() => setShowUnstakeForm(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        flex={1}
                        size="sm"
                        bg="red.500"
                        color="white"
                        fontFamily="mono"
                        fontSize="xs"
                        fontWeight="bold"
                        _hover={{ bg: 'red.400', boxShadow: '0 0 15px rgba(248, 113, 113, 0.4)' }}
                        isLoading={requestUnstakeHook.action?.tx?.isPending}
                        onClick={handleRequestUnstake}
                    >
                        Confirm Unstake
                    </Button>
                </HStack>
            </VStack>
        </Box>
    )
}
