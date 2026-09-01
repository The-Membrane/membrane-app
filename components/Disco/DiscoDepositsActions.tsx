import React from 'react'
import { VStack, HStack, Button } from '@chakra-ui/react'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsActionsProps = Pick<
    DiscoDepositsData,
    | 'currentDeposit'
    | 'completeUnstakeHook'
    | 'cancelUnstakeHook'
    | 'handleCompleteUnstake'
    | 'handleCancelUnstake'
    | 'setShowDepositForm'
    | 'setShowUnstakeForm'
>

export const DiscoDepositsActions: React.FC<DiscoDepositsActionsProps> = ({
    currentDeposit,
    completeUnstakeHook,
    cancelUnstakeHook,
    handleCompleteUnstake,
    handleCancelUnstake,
    setShowDepositForm,
    setShowUnstakeForm,
}) => {
    return (
        <>
            {currentDeposit?.pendingUnstake ? (
                /* Pending unstake: show Complete / Cancel */
                <VStack spacing={3} mt={4}>
                    {currentDeposit.canCompleteUnstake && (
                        <Button
                            w="100%"
                            size="md"
                            bg="green.500"
                            color="white"
                            fontFamily="mono"
                            fontSize="sm"
                            fontWeight="bold"
                            _hover={{
                                bg: 'green.400',
                                boxShadow: '0 0 15px rgba(72, 187, 120, 0.6)'
                            }}
                            isLoading={completeUnstakeHook.action?.tx?.isPending}
                            onClick={handleCompleteUnstake}
                        >
                            Complete Unstake
                        </Button>
                    )}
                    <Button
                        w="100%"
                        size="md"
                        variant="outline"
                        borderColor="whiteAlpha.400"
                        color="whiteAlpha.700"
                        fontFamily="mono"
                        fontSize="sm"
                        _hover={{
                            borderColor: 'whiteAlpha.600',
                            color: 'white',
                        }}
                        isLoading={cancelUnstakeHook.action?.tx?.isPending}
                        onClick={handleCancelUnstake}
                    >
                        Cancel Unstake
                    </Button>
                </VStack>
            ) : (
                /* Normal: Deposit + Request Unstake */
                <>
                    <HStack spacing={3} mt={4}>
                        <Button
                            flex={1}
                            size="md"
                            bg={PRIMARY_PURPLE}
                            color="white"
                            fontFamily="mono"
                            fontSize="sm"
                            fontWeight="bold"
                            _hover={{
                                bg: 'rgb(186, 166, 255)',
                                boxShadow: `0 0 15px ${PRIMARY_PURPLE}60`
                            }}
                            onClick={() => setShowDepositForm(true)}
                        >
                            Deposit
                        </Button>
                    </HStack>
                    <Button
                        w="100%"
                        size="md"
                        variant="outline"
                        borderColor="red.400"
                        color="red.400"
                        fontFamily="mono"
                        fontSize="sm"
                        fontWeight="bold"
                        _hover={{
                            bg: 'rgba(248, 113, 113, 0.2)',
                            borderColor: 'red.300',
                        }}
                        onClick={() => setShowUnstakeForm(true)}
                    >
                        Request Unstake
                    </Button>
                </>
            )}
        </>
    )
}
