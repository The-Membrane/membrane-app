import React from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
} from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { FOCUS_STYLES } from '@/config/transitions'
import {
    DEPOSIT_MIN,
    DEPOSIT_MAX,
    LOCK_DAYS_MIN,
    LOCK_DAYS_MAX,
} from './VisualizerPhysics'

interface AcquisitionVisualizerSlidersProps {
    depositAmount: number
    setDepositAmount: React.Dispatch<React.SetStateAction<number>>
    lockDays: number
    setLockDays: React.Dispatch<React.SetStateAction<number>>
}

export const AcquisitionVisualizerSliders: React.FC<AcquisitionVisualizerSlidersProps> = ({
    depositAmount,
    setDepositAmount,
    lockDays,
    setLockDays,
}) => {
    return (
        <HStack spacing={8} justify="center" flexWrap="wrap">
            {/* Deposit Slider */}
            <VStack spacing={3} minW="300px" maxW="400px">
                <Text
                    fontSize="lg"
                    fontWeight="bold"
                    color={SEMANTIC_COLORS.info}
                    fontFamily="mono"
                >
                    DEPOSIT AMOUNT
                </Text>
                <Box
                    position="relative"
                    w="100%"
                    bg={SEMANTIC_COLORS.bgTertiary}
                    borderRadius={0}
                    p={4}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                    <Slider
                        min={DEPOSIT_MIN}
                        max={DEPOSIT_MAX}
                        value={depositAmount}
                        onChange={setDepositAmount}
                        step={10000}
                    >
                        <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="4px">
                            <SliderFilledTrack bg={SEMANTIC_COLORS.info} />
                        </SliderTrack>
                        <SliderThumb
                            boxSize={8}
                            bg={SEMANTIC_COLORS.info}
                            border="2px solid"
                            borderColor={SEMANTIC_COLORS.textPrimary}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                        />
                    </Slider>
                </Box>
                <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color={SEMANTIC_COLORS.info}
                    fontFamily="mono"
                >
                    {depositAmount.toLocaleString()} USDC
                </Text>
            </VStack>

            {/* Lock Days Slider */}
            <VStack spacing={3} minW="300px" maxW="400px">
                <Text
                    fontSize="lg"
                    fontWeight="bold"
                    color={SEMANTIC_COLORS.primary}
                    fontFamily="mono"
                >
                    LOCK DAYS
                </Text>
                <Box
                    position="relative"
                    w="100%"
                    bg={SEMANTIC_COLORS.bgTertiary}
                    borderRadius={0}
                    p={4}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                    <Slider
                        min={LOCK_DAYS_MIN}
                        max={LOCK_DAYS_MAX}
                        value={lockDays}
                        onChange={setLockDays}
                        step={1}
                    >
                        <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="4px">
                            <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
                        </SliderTrack>
                        <SliderThumb
                            boxSize={8}
                            bg={SEMANTIC_COLORS.primary}
                            border="2px solid"
                            borderColor={SEMANTIC_COLORS.textPrimary}
                            _focus={FOCUS_STYLES.ring}
                            _focusVisible={FOCUS_STYLES.ring}
                        />
                    </Slider>
                </Box>
                <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color={SEMANTIC_COLORS.primary}
                    fontFamily="mono"
                >
                    {lockDays} DAYS
                </Text>
            </VStack>
        </HStack>
    )
}
