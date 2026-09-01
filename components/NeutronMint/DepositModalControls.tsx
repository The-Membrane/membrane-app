import React from 'react'
import {
    GridItem,
    VStack,
    HStack,
    Box,
    Text,
    Input,
    Button,
    Image,
} from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { DepositModalHexSlider } from './DepositModalHexSlider'

interface DepositModalControlsProps {
    asset: {
        symbol: string
        denom: string
        logo: string
        price: number
        decimal?: number
    }
    depositAmount: number
    walletBalance: number
    sliderValue: number
    handleAmountChange: (value: number) => void
    handleSliderChange: (value: number) => void
    handleMaxClick: () => void
    isDisabled: boolean | undefined
    isLoading: boolean | undefined
    onDepositClick: () => void
    simulateError: boolean | undefined
    simulateErrorMessage: string | undefined
}

/**
 * Left column of DepositModal — amount input, hex slider, and deposit CTA. Extracted verbatim
 * from DepositModal to keep the parent under the giant-component line limit.
 */
export const DepositModalControls: React.FC<DepositModalControlsProps> = ({
    asset,
    depositAmount,
    walletBalance,
    sliderValue,
    handleAmountChange,
    handleSliderChange,
    handleMaxClick,
    isDisabled,
    isLoading,
    onDepositClick,
    simulateError,
    simulateErrorMessage,
}) => {
    return (
        <GridItem>
            <VStack spacing={6} align="stretch">
                <Box
                    bg="rgba(10, 10, 10, 0.8)"
                    borderRadius="lg"
                    p={4}
                    border="1px solid"
                    borderColor="whiteAlpha.200"
                >
                    <VStack spacing={4} align="stretch">
                        <Text color="whiteAlpha.600" fontSize="xs">
                            Deposit {asset.symbol} as collateral
                        </Text>

                        {/* Amount Input */}
                        <Box>
                            <HStack justify="space-between" mb={2}>
                                <HStack spacing={2}>
                                    <Image
                                        src={asset.logo}
                                        alt={asset.symbol}
                                        w="24px"
                                        h="24px"
                                        borderRadius="full"
                                        fallbackSrc="/images/default-token.svg"
                                    />
                                    <Text color="white" fontSize="lg" fontWeight="medium">
                                        {asset.symbol}
                                    </Text>
                                </HStack>
                                <HStack spacing={2}>
                                    <Text color="whiteAlpha.600" fontSize="sm">
                                        Balance: {num(walletBalance).toFixed(4)}
                                    </Text>
                                    <Button
                                        size="xs"
                                        variant="outline"
                                        colorScheme="cyan"
                                        onClick={handleMaxClick}
                                    >
                                        MAX
                                    </Button>
                                </HStack>
                            </HStack>

                            <Input
                                value={depositAmount > 0 ? depositAmount.toString() : ''}
                                onChange={(e) => {
                                    const value = parseFloat(e.target.value) || 0
                                    handleAmountChange(value)
                                }}
                                placeholder="0"
                                type="number"
                                bg="rgba(0, 0, 0, 0.3)"
                                borderColor="whiteAlpha.200"
                                color="white"
                                fontSize="2xl"
                                fontWeight="bold"
                                textAlign="right"
                                _focus={{ borderColor: 'cyan.400', boxShadow: '0 0 0 1px cyan.400' }}
                                mb={2}
                            />

                            <HStack justify="space-between" mb={4}>
                                <Text color="whiteAlpha.600" fontSize="sm">
                                    ~ ${num(depositAmount).times(asset.price).toFixed(2)}
                                </Text>
                            </HStack>

                            {/* Hexagon Slider */}
                            <DepositModalHexSlider
                                sliderValue={sliderValue}
                                walletBalance={walletBalance}
                                handleSliderChange={handleSliderChange}
                            />
                        </Box>

                        <Text color="whiteAlpha.400" fontSize="xs" textAlign="left">
                            Deposits increase collateral value and improve position health
                        </Text>

                        {/* Deposit Button */}
                        <Button
                            size="lg"
                            colorScheme="cyan"
                            bg="cyan.500"
                            _hover={{ bg: 'cyan.600' }}
                            isDisabled={isDisabled}
                            isLoading={isLoading}
                            onClick={onDepositClick}
                            fontWeight="bold"
                            fontSize="md"
                        >
                            Deposit →
                        </Button>

                        {/* Error messages */}
                        {depositAmount > walletBalance && walletBalance > 0 && (
                            <Text color="red.400" fontSize="sm" textAlign="center">
                                Insufficient {asset.symbol} balance
                            </Text>
                        )}
                        {simulateError && (
                            <Text color="red.400" fontSize="sm" textAlign="center">
                                {simulateErrorMessage || 'Transaction simulation failed'}
                            </Text>
                        )}
                    </VStack>
                </Box>
            </VStack>
        </GridItem>
    )
}
