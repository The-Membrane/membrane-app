import React from 'react'
import {
    VStack,
    HStack,
    Box,
    Text,
    Input,
    Button,
    Image,
} from '@chakra-ui/react'
import { num } from '@/helpers/num'
import type { DebtAsset } from './RepayModalConstants'

interface RepaySliderProps {
    sliderValue: number
    handleSliderChange: (value: number) => void
    maxRepayable: number
}

const RepaySlider: React.FC<RepaySliderProps> = ({
    sliderValue,
    handleSliderChange,
    maxRepayable,
}) => {
    return (
        <Box px={2} position="relative">
            <Box position="relative" h="12px" w="100%" overflow="hidden">
                {/* Hidden range input */}
                <Box
                    as="input"
                    type="range"
                    value={sliderValue}
                    onChange={(e: any) => handleSliderChange(Number(e.target.value))}
                    min={0}
                    max={100}
                    step={1}
                    disabled={maxRepayable <= 0}
                    position="absolute"
                    zIndex={2}
                    w="100%"
                    h="12px"
                    opacity={0}
                    cursor="pointer"
                    style={{
                        appearance: 'none',
                        WebkitAppearance: 'none',
                    }}
                />
                {/* Slider track with segments and markers */}
                <HStack
                    position="absolute"
                    w="100%"
                    spacing={1}
                    align="center"
                    h="4px"
                    top="4px"
                >
                    {[0, 25, 50, 75, 100].map((mark, index) => {
                        const isActive = sliderValue >= mark
                        const isLast = index === 4
                        const nextMark = isLast ? 100 : [0, 25, 50, 75, 100][index + 1]
                        const segmentProgress = isLast
                            ? 0
                            : Math.max(0, Math.min(100, ((sliderValue - mark) / (nextMark - mark)) * 100))

                        return (
                            <React.Fragment key={mark}>
                                <Box
                                    as="button"
                                    type="button"
                                    zIndex={20}
                                    w="12px"
                                    h="12px"
                                    outline="none !important"
                                    _hover={{ opacity: 0.8 }}
                                    onClick={() => handleSliderChange(mark)}
                                    cursor="pointer"
                                    flexShrink={0}
                                    display="flex"
                                    alignItems="center"
                                    justifyContent="center"
                                >
                                    <Box
                                        as="svg"
                                        width="12px"
                                        height="12px"
                                        viewBox="0 0 12 12"
                                    >
                                        <polygon
                                            points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                                            fill={isActive ? '#9bdc4f' : 'transparent'}
                                            stroke={isActive ? '#9bdc4f' : 'rgba(255, 255, 255, 0.4)'}
                                            strokeWidth="1.5"
                                        />
                                    </Box>
                                </Box>
                                {!isLast && (
                                    <Box
                                        position="relative"
                                        flex={1}
                                        h="4px"
                                        borderRadius="sm"
                                        bg="whiteAlpha.100"
                                    >
                                        <Box
                                            position="relative"
                                            zIndex={1}
                                            h="4px"
                                            borderRadius="sm"
                                            bg="cyan.400"
                                            w={`${segmentProgress}%`}
                                            transition="width 0.1s"
                                        />
                                    </Box>
                                )}
                            </React.Fragment>
                        )
                    })}
                </HStack>
                {/* Draggable thumb */}
                <Box
                    position="absolute"
                    zIndex={20}
                    left={`${sliderValue}%`}
                    transform="translate(-50%, 0px)"
                    cursor="pointer"
                    top="0px"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <Box
                        as="svg"
                        width="12px"
                        height="12px"
                        viewBox="0 0 12 12"
                        zIndex={20}
                        outline="none !important"
                        _hover={{ cursor: 'pointer' }}
                    >
                        <polygon
                            points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                            fill="#9bdc4f"
                            stroke="#9bdc4f"
                            strokeWidth="2"
                        />
                    </Box>
                </Box>
            </Box>
        </Box>
    )
}

interface RepayAmountPanelProps {
    selectedAsset: DebtAsset
    maxRepayable: number
    repayAmount: number
    sliderValue: number
    handleAmountChange: (value: number) => void
    handleSliderChange: (value: number) => void
    handleMaxClick: () => void
    isDisabled?: boolean
    isLoading?: boolean
    onRepay: () => void
    simulateIsError?: boolean
    simulateErrorMessage?: string
}

export const RepayAmountPanel: React.FC<RepayAmountPanelProps> = ({
    selectedAsset,
    maxRepayable,
    repayAmount,
    sliderValue,
    handleAmountChange,
    handleSliderChange,
    handleMaxClick,
    isDisabled,
    isLoading,
    onRepay,
    simulateIsError,
    simulateErrorMessage,
}) => {
    return (
        <VStack spacing={6} align="stretch">
            {/* Amount & Slider Section */}
            <Box
                bg="rgba(10, 10, 10, 0.8)"
                borderRadius="lg"
                p={4}
                border="1px solid"
                borderColor="whiteAlpha.200"
            >
                <VStack spacing={4} align="stretch">
                    <Text color="whiteAlpha.600" fontSize="xs">
                        Repay {selectedAsset.symbol} to reduce your debt
                    </Text>

                    {/* Amount Input */}
                    <Box>
                        <HStack justify="space-between" mb={2}>
                            <HStack spacing={2}>
                                <Image src={selectedAsset.logo} alt={selectedAsset.symbol} w="24px" h="24px" borderRadius="full" />
                                <Text color="white" fontSize="lg" fontWeight="medium">
                                    {selectedAsset.symbol}
                                </Text>
                            </HStack>
                            <HStack spacing={2}>
                                <Text color="whiteAlpha.600" fontSize="sm">
                                    Debt: {num(maxRepayable).toFixed(2)}
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
                            value={repayAmount > 0 ? repayAmount.toString() : ''}
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
                                ~ ${num(repayAmount).toFixed(2)}
                            </Text>
                        </HStack>

                        {/* Slider */}
                        <RepaySlider
                            sliderValue={sliderValue}
                            handleSliderChange={handleSliderChange}
                            maxRepayable={maxRepayable}
                        />
                    </Box>

                    <HStack spacing={1}>
                        <Text color="whiteAlpha.400" fontSize="xs" textAlign="left">
                            Repayments reduce variable rate debt first, then fixed (1mo → 3mo → 6mo)
                        </Text>
                    </HStack>

                    {/* Repay Button */}
                    <Button
                        size="lg"
                        colorScheme="cyan"
                        bg="cyan.500"
                        _hover={{ bg: 'cyan.600' }}
                        isDisabled={isDisabled}
                        isLoading={isLoading}
                        onClick={onRepay}
                        fontWeight="bold"
                        fontSize="md"
                    >
                        Repay
                    </Button>

                    {/* Error message */}
                    {simulateIsError && (
                        <Text color="red.400" fontSize="sm" textAlign="center">
                            {simulateErrorMessage || 'Transaction simulation failed'}
                        </Text>
                    )}
                </VStack>
            </Box>

        </VStack>
    )
}
