import React, { useState } from 'react'
import {
    VStack,
    Text,
    Box,
    HStack,
    Button,
    Slider,
    SliderTrack,
    SliderFilledTrack,
    SliderThumb,
} from '@chakra-ui/react'

interface EditLockFormProps {
    depositType: 'staking' | 'disco'
    currentLockDays: number
    onSubmit: (newLockDays: number) => void
}

export const EditLockForm: React.FC<EditLockFormProps> = ({ depositType, currentLockDays, onSubmit }) => {
    const [lockDays, setLockDays] = useState(currentLockDays)

    const handleSubmit = () => {
        if (lockDays <= currentLockDays) return
        onSubmit(lockDays)
    }

    const isStaking = depositType === 'staking'
    const maxLockDays = 365
    const canExtend = lockDays > currentLockDays

    return (
        <VStack align="stretch" spacing={4} w="100%" h="100%" pb="50px" overflowY="auto">
            <Text fontSize="xs" color="#F5F5F580" fontWeight="bold" textTransform="uppercase">
                Extend Lock Duration
            </Text>

            {/* Current Lock Info */}
            <Box
                bg="#1A1D26"
                border="1px solid"
                borderColor="#6943FF30"
                borderRadius="md"
                p={3}
            >
                <HStack justify="space-between">
                    <Text fontSize="xs" color="#F5F5F580">
                        Current Lock
                    </Text>
                    <Text fontSize="xs" color="purple.300" fontWeight="bold">
                        {currentLockDays} days remaining
                    </Text>
                </HStack>
            </Box>

            {/* Lock Days Slider */}
            <Box>
                <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color="#F5F5F580">
                        New Lock Duration
                    </Text>
                    <Text fontSize="xs" color={canExtend ? 'cyan.300' : '#F5F5F580'} fontWeight="bold">
                        {lockDays} days
                    </Text>
                </HStack>
                <Slider
                    value={lockDays}
                    onChange={(val) => setLockDays(val)}
                    min={currentLockDays}
                    max={maxLockDays}
                    step={1}
                >
                    <SliderTrack bg="#1A1D26" h="6px" borderRadius="full">
                        <SliderFilledTrack bg={canExtend ? 'blue.400' : 'gray.500'} />
                    </SliderTrack>
                    <SliderThumb
                        boxSize={4}
                        bg={canExtend ? 'blue.400' : 'gray.500'}
                        border="2px solid"
                        borderColor="white"
                        _focus={{ boxShadow: '0 0 10px rgba(66, 153, 225, 0.5)' }}
                    />
                </Slider>
                <HStack justify="space-between" mt={1}>
                    <Text fontSize="2xs" color="#F5F5F550">{currentLockDays}</Text>
                    <Text fontSize="2xs" color="#F5F5F550">{maxLockDays}</Text>
                </HStack>
            </Box>

            {/* Extension Preview */}
            {canExtend && (
                <Box
                    bg="#1A1D26"
                    border="1px solid"
                    borderColor="#4299E130"
                    borderRadius="md"
                    p={3}
                >
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Extension
                            </Text>
                            <Text fontSize="xs" color="blue.300" fontWeight="bold">
                                +{lockDays - currentLockDays} days
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text fontSize="xs" color="#F5F5F580">
                                Effective MBRN Boost
                            </Text>
                            <Text fontSize="xs" color="cyan.300" fontWeight="bold">
                                {(lockDays + 1).toFixed(1)}x
                            </Text>
                        </HStack>
                    </VStack>
                </Box>
            )}

            {/* Info Text */}
            <Text fontSize="2xs" color="#F5F5F550">
                Note: Lock days decrease over time as the lock period progresses. You can extend the lock to maintain or increase your boost.
            </Text>

            {/* Submit Button */}
            <Button
                position="fixed"
                bottom={0}
                left={0}
                right={0}
                size="sm"
                bg="blue.500"
                color="white"
                onClick={handleSubmit}
                isDisabled={!canExtend}
                _hover={{ bg: 'blue.400', boxShadow: '0 0 15px rgba(66, 153, 225, 0.4)' }}
                _disabled={{ opacity: 0.5, cursor: 'not-allowed' }}
            >
                Extend Lock
            </Button>
        </VStack>
    )
}

