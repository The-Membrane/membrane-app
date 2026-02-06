import React, { useMemo, useState, useEffect } from 'react'
import { Box, Text } from '@chakra-ui/react'
import dayjs from 'dayjs'

type LockdropProgressBarProps = {
    startTime: number | undefined
    depositEnd: number | undefined
    withdrawalEnd: number | undefined
    currentTime?: number // Optional, defaults to current time
}

export const LockdropProgressBar: React.FC<LockdropProgressBarProps> = ({
    startTime,
    depositEnd,
    withdrawalEnd,
    currentTime,
}) => {
    // Update current time every second if not provided
    const [now, setNow] = useState(() => currentTime || Math.floor(Date.now() / 1000))

    useEffect(() => {
        if (currentTime !== undefined) {
            setNow(currentTime)
            return
        }

        // Update every second
        const interval = setInterval(() => {
            setNow(Math.floor(Date.now() / 1000))
        }, 1000)

        return () => clearInterval(interval)
    }, [currentTime])

    // Calculate percentages
    const calculations = useMemo(() => {
        if (!startTime || !depositEnd || !withdrawalEnd) {
            return {
                depositWidth: 0,
                withdrawalWidth: 0,
                currentPosition: 0,
                depositFillPercent: 0,
                withdrawalFillPercent: 0,
                isBeforeStart: false,
                isAfterWithdrawal: false,
            }
        }

        const totalDuration = withdrawalEnd - startTime
        const depositDuration = depositEnd - startTime
        const withdrawalDuration = withdrawalEnd - depositEnd

        // Calculate segment widths as percentages
        const depositWidth = (depositDuration / totalDuration) * 100
        const withdrawalWidth = (withdrawalDuration / totalDuration) * 100

        // Calculate current position and fill percentages
        let currentPosition = 0
        let depositFillPercent = 0
        let withdrawalFillPercent = 0
        let isBeforeStart = false
        let isAfterWithdrawal = false

        if (now < startTime) {
            isBeforeStart = true
            currentPosition = 0
            depositFillPercent = 0
            withdrawalFillPercent = 0
        } else if (now > withdrawalEnd) {
            isAfterWithdrawal = true
            currentPosition = 100
            depositFillPercent = 100
            withdrawalFillPercent = 100
        } else {
            currentPosition = ((now - startTime) / totalDuration) * 100

            // Calculate deposit segment fill
            if (now >= depositEnd) {
                depositFillPercent = 100
            } else if (now >= startTime) {
                depositFillPercent = ((now - startTime) / depositDuration) * 100
            }

            // Calculate withdrawal segment fill
            if (now >= withdrawalEnd) {
                withdrawalFillPercent = 100
            } else if (now >= depositEnd) {
                withdrawalFillPercent = ((now - depositEnd) / withdrawalDuration) * 100
            }
        }

        return {
            depositWidth,
            withdrawalWidth,
            currentPosition,
            depositFillPercent,
            withdrawalFillPercent,
            isBeforeStart,
            isAfterWithdrawal,
        }
    }, [startTime, depositEnd, withdrawalEnd, now])

    if (!startTime || !depositEnd || !withdrawalEnd) {
        return null
    }

    const { depositWidth, withdrawalWidth, currentPosition, depositFillPercent, withdrawalFillPercent } = calculations

    // Calculate time remaining until withdrawal_end
    const timeRemaining = useMemo(() => {
        if (!withdrawalEnd) return null
        const remaining = withdrawalEnd - now
        if (remaining <= 0) return '0d 0h 0m'

        const days = Math.floor(remaining / 86400)
        const hours = Math.floor((remaining % 86400) / 3600)
        const minutes = Math.floor((remaining % 3600) / 60)

        return `${days}d ${hours}h ${minutes}m`
    }, [withdrawalEnd, now])

    // Cyberpunk colors - contrasting colors for segments
    // Using Chakra UI gradient syntax
    const depositGradient = 'linear(to-r, purple.500, purple.600)'
    const withdrawalGradient = 'linear(to-r, cyan.500, cyan.600)'
    const currentTimeMarkerColor = '#a78bfa' // purple.300
    const finishLineColor = '#d4af37' // gold

    return (
        <Box position="relative" w="100%" h="60px" mb={2}>
            {/* Progress Bar Container */}
            <Box
                position="relative"
                w="100%"
                h="40px"
                bg="rgba(20, 20, 30, 0.6)"
                borderRadius="md"
                border="2px solid"
                borderColor="purple.400"
                overflow="visible"
            >
                {/* Deposit Segment Background */}
                <Box
                    position="absolute"
                    left="0"
                    top="0"
                    width={`${depositWidth}%`}
                    height="100%"
                    borderRight="1px solid"
                    borderColor="purple.400"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <Text
                        fontSize="xs"
                        fontWeight="bold"
                        color="purple.300"
                        fontFamily="mono"
                        textShadow="0 0 4px rgba(0,0,0,0.8)"
                        whiteSpace="nowrap"
                        zIndex={5}
                    >
                        DEPOSIT-ONLY
                    </Text>
                </Box>

                {/* Deposit Segment Fill */}
                <Box
                    position="absolute"
                    left="0"
                    top="0"
                    width={`${depositWidth * (depositFillPercent / 100)}%`}
                    height="100%"
                    bgGradient={depositGradient}
                    zIndex={1}
                />

                {/* Withdrawal Segment Background */}
                <Box
                    position="absolute"
                    left={`${depositWidth}%`}
                    top="0"
                    width={`${withdrawalWidth}%`}
                    height="100%"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <Text
                        fontSize="xs"
                        fontWeight="bold"
                        color="cyan.300"
                        fontFamily="mono"
                        textShadow="0 0 4px rgba(0,0,0,0.8)"
                        whiteSpace="nowrap"
                        zIndex={5}
                    >
                        WITHDRAW-ONLY
                    </Text>
                </Box>

                {/* Withdrawal Segment Fill */}
                <Box
                    position="absolute"
                    left={`${depositWidth}%`}
                    top="0"
                    width={`${withdrawalWidth * (withdrawalFillPercent / 100)}%`}
                    height="100%"
                    bgGradient={withdrawalGradient}
                    zIndex={1}
                />

                {/* Current Time Marker - Vertical Line */}
                <Box
                    position="absolute"
                    left={`${Math.min(100, Math.max(0, currentPosition))}%`}
                    top="0"
                    width="3px"
                    height="100%"
                    bg={currentTimeMarkerColor}
                    boxShadow={`0 0 8px ${currentTimeMarkerColor}, 0 0 12px ${currentTimeMarkerColor}`}
                    zIndex={15}
                    transform="translateX(-50%)"
                />
                {/* Current Time Label - Shows time remaining */}
                {timeRemaining && (
                    <Box
                        position="absolute"
                        left={`${Math.min(100, Math.max(0, currentPosition))}%`}
                        top="-32px"
                        transform="translateX(-50%)"
                        zIndex={16}
                        textAlign="center"
                    >
                        <Text
                            fontSize="9px"
                            fontWeight="bold"
                            color={currentTimeMarkerColor}
                            fontFamily="mono"
                            whiteSpace="nowrap"
                            textShadow="0 0 4px rgba(0,0,0,0.8)"
                            lineHeight="1.2"
                        >
                            Time Left:
                        </Text>
                        <Text
                            fontSize="10px"
                            fontWeight="bold"
                            color={currentTimeMarkerColor}
                            fontFamily="mono"
                            whiteSpace="nowrap"
                            textShadow="0 0 4px rgba(0,0,0,0.8)"
                            lineHeight="1.2"
                        >
                            {timeRemaining}
                        </Text>
                    </Box>
                )}
                {/* Finish Line Flag/Banner - Positioned at the end of the progress bar */}
                <Box
                    position="absolute"
                    right="-83px"
                    top="-12px"
                    width="85px"
                    height="64px"
                    zIndex={20}
                >
                    {/* Flag Pole */}
                    <Box
                        position="absolute"
                        left="0"
                        top="-39px"
                        width="4px"
                        height="88px"
                        bg={finishLineColor}
                        boxShadow={`0 0 8px ${finishLineColor}, 0 0 12px ${finishLineColor}`}
                        borderRadius="2px"
                    />
                    {/* Flag Banner */}
                    <Box
                        position="absolute"
                        left="-76px"
                        top="-40px"
                        width="81px"
                        height="38px"
                        bg={finishLineColor}
                        clipPath="polygon(0 0, 100% 0, 100% 88%, 0 100%)"
                        boxShadow={`0 0 12px ${finishLineColor}, 0 0 18px ${finishLineColor}, inset 0 0 8px rgba(212, 175, 55, 0.3)`}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        border="1px solid"
                        borderColor="rgba(0, 0, 0, 0.3)"
                    >
                        <Text
                            fontSize="11px"
                            fontWeight="bold"
                            color="#000000"
                            fontFamily="mono"
                            textAlign="center"
                            lineHeight="1.2"
                            textShadow="0 1px 2px rgba(255, 255, 255, 0.3)"
                        >
                            10M
                            <br />
                            MBRN
                        </Text>
                    </Box>
                </Box>
            </Box>
        </Box>
    )
}

