import React from 'react'
import { Box, HStack } from '@chakra-ui/react'

interface DepositModalHexSliderProps {
    sliderValue: number
    walletBalance: number
    handleSliderChange: (value: number) => void
}

/**
 * Custom hexagon deposit slider (0-100). Extracted verbatim from DepositModal — a hidden
 * native range input handles dragging/accessibility while the visible track renders segmented
 * hexagon markers and a draggable thumb.
 */
export const DepositModalHexSlider: React.FC<DepositModalHexSliderProps> = ({
    sliderValue,
    walletBalance,
    handleSliderChange,
}) => {
    return (
        <Box px={2} position="relative">
            <Box position="relative" minH="12px" w="100%">
                <Box
                    as="input"
                    type="range"
                    value={sliderValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSliderChange(Number(e.target.value))}
                    min={0}
                    max={100}
                    step={1}
                    disabled={walletBalance <= 0}
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
                                    <Box as="svg" width="12px" height="12px" viewBox="0 0 12 12">
                                        <polygon
                                            points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                                            fill={isActive ? '#00D9FF' : 'transparent'}
                                            stroke={isActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.4)'}
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
                    >
                        <polygon
                            points="6,0 10.392,3 10.392,9 6,12 1.608,9 1.608,3"
                            fill="#00D9FF"
                            stroke="#00E5FF"
                            strokeWidth="2"
                        />
                    </Box>
                </Box>
            </Box>
        </Box>
    )
}
