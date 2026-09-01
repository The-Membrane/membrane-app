import React, { useMemo, useState, useEffect } from 'react'
import { Box, Text } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

type AcquisitionProgressBarProps = {
    startTime: number | undefined
    depositEnd: number | undefined
    withdrawalEnd: number | undefined
    currentTime?: number // Optional, defaults to current time
}

export const AcquisitionProgressBar: React.FC<AcquisitionProgressBarProps> = ({
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

    // Calculate time remaining until withdrawal_end.
    //
    // MUST stay above the early return below. It previously sat after it, so a
    // render with the timestamps missing called one hook and a later render with
    // them present called two. React identifies hooks by call order, so that
    // changing count throws "Rendered more hooks than during the previous
    // render" — a crash, not a warning, triggered by data simply arriving.
    const timeRemaining = useMemo(() => {
        if (!withdrawalEnd) return null
        const remaining = withdrawalEnd - now
        if (remaining <= 0) return '0d 0h 0m'

        const days = Math.floor(remaining / 86400)
        const hours = Math.floor((remaining % 86400) / 3600)
        const minutes = Math.floor((remaining % 3600) / 60)

        return `${days}d ${hours}h ${minutes}m`
    }, [withdrawalEnd, now])

    if (!startTime || !depositEnd || !withdrawalEnd) {
        return null
    }

    const { depositWidth, withdrawalWidth, currentPosition, depositFillPercent, withdrawalFillPercent } = calculations

    // Colors (group-wide phase mapping: deposit = teal, withdrawal = gold)
    const depositColor = SEMANTIC_COLORS.info // teal — deposit phase
    const withdrawalColor = SEMANTIC_COLORS.warning // gold — withdrawal phase
    const markerColor = SEMANTIC_COLORS.textPrimary // bone time cursor

    // Clamp card position so it doesn't overflow edges
    const clampedPosition = Math.min(85, Math.max(15, currentPosition))

    return (
        <Box position="relative" w="100%" pt={12} pb={2}>
            {/* Time Remaining Card - follows progress */}
            {timeRemaining && (
                <Box
                    position="absolute"
                    left={`${clampedPosition}%`}
                    top="0"
                    transform="translateX(-50%)"
                    zIndex={16}
                    bg={SEMANTIC_COLORS.bgSecondary}
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    borderRadius={0}
                    px={3}
                    py={1}
                    textAlign="center"
                    transition="left 1s linear"
                >
                    <Text
                        fontSize="9px"
                        fontWeight="bold"
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily="mono"
                        whiteSpace="nowrap"
                        lineHeight="1.2"
                        textTransform="uppercase"
                    >
                        Time Left
                    </Text>
                    <Text
                        fontSize="12px"
                        fontWeight="bold"
                        color={markerColor}
                        fontFamily="mono"
                        whiteSpace="nowrap"
                        lineHeight="1.3"
                    >
                        {timeRemaining}
                    </Text>
                </Box>
            )}

            {/* Progress Bar Container */}
            <Box
                position="relative"
                w="100%"
                h="40px"
                bg={SEMANTIC_COLORS.bgTertiary}
                borderRadius={0}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                overflow="hidden"
            >
                {/* Deposit Segment Background */}
                <Box
                    position="absolute"
                    left="0"
                    top="0"
                    width={`${depositWidth}%`}
                    height="100%"
                    borderRight="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <Text
                        fontSize="xs"
                        fontWeight="bold"
                        color={SEMANTIC_COLORS.info}
                        fontFamily="mono"
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
                    bg={depositColor}
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
                        color={SEMANTIC_COLORS.warning}
                        fontFamily="mono"
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
                    bg={withdrawalColor}
                    zIndex={1}
                />

                {/* Current Time Marker - Vertical Line */}
                <Box
                    position="absolute"
                    left={`${Math.min(100, Math.max(0, currentPosition))}%`}
                    top="0"
                    width="3px"
                    height="100%"
                    bg={markerColor}
                    zIndex={15}
                    transform="translateX(-50%)"
                    transition="left 1s linear"
                />
            </Box>
        </Box>
    )
}
