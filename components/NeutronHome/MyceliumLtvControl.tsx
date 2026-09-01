import React from 'react';
import { VStack, HStack, Text, Input, Slider, SliderTrack, SliderFilledTrack, SliderThumb } from '@chakra-ui/react';
import { ManagedActionState } from '@/components/ManagedMarkets/hooks/useManagedMarketState';

interface MyceliumLtvControlProps {
    large?: boolean;
    amount: string;
    mode: 'multiply' | 'de-risk';
    resolvedMaxBorrowLTV: number;
    managedActionState: ManagedActionState;
    maxMultiplier: number;
    setSelectedMultiplier: React.Dispatch<React.SetStateAction<string>>;
    setManagedActionState: (partial: Partial<ManagedActionState>) => void;
    ltvInputValue: string;
    setLtvInputValue: React.Dispatch<React.SetStateAction<string>>;
    inputRef: React.RefObject<HTMLInputElement>;
}

const MyceliumLtvControl: React.FC<MyceliumLtvControlProps> = ({
    large,
    amount,
    mode,
    resolvedMaxBorrowLTV,
    managedActionState,
    maxMultiplier,
    setSelectedMultiplier,
    setManagedActionState,
    ltvInputValue,
    setLtvInputValue,
    inputRef,
}) => {
    return (
        <VStack opacity={!amount || amount === '0' ? 0.3 : 1} transition="opacity 0.2s">
            <HStack
                gap={4}
                align="center"
                spacing={2}
                w={{ base: '90vw', md: large ? '420px' : '320px' }}
                borderRadius="md"
                justify={{ base: 'center', md: undefined }}
                transition="all 0.2s"
            >
                {/* Local Chakra slider + input for LTV (0 - resolvedMaxBorrowLTV) */}
                <HStack w="100%" opacity={mode === 'de-risk' ? 0.5 : 1} pointerEvents={mode === 'de-risk' || !amount || amount === '0' ? 'none' : 'auto'}>
                    <Slider
                        aria-label='ltv-slider'
                        w="100%"
                        min={0}
                        max={resolvedMaxBorrowLTV}
                        step={0.005}
                        focusThumbOnChange={false}
                        value={(() => {
                            const m = managedActionState.multiplier;
                            if (!m || m <= 1) return 0;
                            const ltv = 1 - 1 / m;
                            return Math.max(0, Math.min(resolvedMaxBorrowLTV, ltv));
                        })()}
                        onChange={(ltv) => {
                            const multiplierFromLTV = ltv >= resolvedMaxBorrowLTV ? maxMultiplier : (ltv >= 0 ? 1 / (1 - ltv) : 1);
                            setSelectedMultiplier(String(multiplierFromLTV));
                            if (mode === 'multiply') {
                                setManagedActionState({
                                    collateralAmount: amount,
                                    multiplier: multiplierFromLTV,
                                });
                            }
                        }}
                    >
                        <SliderTrack h="10px" borderRadius="full">
                            <SliderFilledTrack />
                        </SliderTrack>
                        <SliderThumb boxSize="18px" />
                    </Slider>
                    {/* Number input for LTV */}
                    <Input
                        ref={inputRef}
                        value={ltvInputValue}
                        onChange={(e) => {
                            const inputValue = e.target.value;
                            setLtvInputValue(inputValue);

                            const valueAsNumber = parseFloat(inputValue);
                            if (isNaN(valueAsNumber)) return;

                            const ltv = Math.max(0, Math.min(resolvedMaxBorrowLTV * 100, valueAsNumber)) / 100;
                            const multiplierFromLTV = ltv >= resolvedMaxBorrowLTV ? maxMultiplier : (ltv >= 0 ? 1 / (1 - ltv) : 1);
                            setSelectedMultiplier(String(multiplierFromLTV));
                            if (mode === 'multiply') {
                                setManagedActionState({
                                    collateralAmount: amount,
                                    multiplier: multiplierFromLTV,
                                });
                            }
                        }}
                        onBlur={() => {
                            // Format to one decimal place on blur
                            const valueAsNumber = parseFloat(ltvInputValue);
                            if (!isNaN(valueAsNumber)) {
                                const clamped = Math.max(0, Math.min(resolvedMaxBorrowLTV * 100, valueAsNumber));
                                setLtvInputValue(clamped.toFixed(1));
                            }
                        }}
                        type="text"
                        color="white"
                        textAlign="center"
                        paddingInlineEnd={0}
                        paddingEnd={0}
                        paddingInlineStart={0}
                        width="63px"
                        variant="unstyled"
                        fontSize="sm"
                    />
                    <Text color="white" whiteSpace="nowrap" flexShrink={0}>% LTV</Text>
                </HStack>
            </HStack>
            {/* Info text under borrow slider */}
            {/* <Text color="whiteAlpha.700" fontSize="sm" mt={1} mb={-2} display={{ base: 'none', md: 'block' }}>
            { }% yield boost
            </Text> */}
        </VStack>
    );
};

export default MyceliumLtvControl;
