import React, { useEffect, useState } from 'react'
import { Box, VStack, HStack, Text } from '@chakra-ui/react'
import { motion, useMotionValue, useSpring } from 'framer-motion'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

interface MetricsCardProps {
    totalDeposits: number
    averageLTV: number
    activeTranches: number
    yieldRange: string
    pendingRevenue: number
    totalInsurance: number
    recentLiquidations: number
}

export const MetricsCard: React.FC<MetricsCardProps> = ({
    totalDeposits,
    averageLTV,
    activeTranches,
    yieldRange,
    pendingRevenue,
    totalInsurance,
    recentLiquidations,
}) => {
    // Animated Counter Component
    const AnimatedCounter: React.FC<{ value: number; decimals?: number }> = ({ value, decimals = 0 }) => {
        const motionValue = useMotionValue(0)
        const spring = useSpring(motionValue, { stiffness: 50, damping: 30 })
        const [displayValue, setDisplayValue] = useState(0)

        useEffect(() => {
            motionValue.set(value)
        }, [value, motionValue])

        useEffect(() => {
            const unsubscribe = spring.on('change', (latest) => {
                setDisplayValue(latest)
            })
            return () => unsubscribe()
        }, [spring])

        const formattedValue = decimals > 0
            ? parseFloat(displayValue.toFixed(decimals)).toLocaleString()
            : Math.round(displayValue).toLocaleString()

        return (
            <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5 }}
            >
                {formattedValue}
            </motion.span>
        )
    }

    const MetricRow: React.FC<{ label: string; value: string | number; unit?: string }> = ({
        label,
        value,
        unit = '',
    }) => {
        const isNumber = typeof value === 'number'
        const numValue = isNumber ? value : 0
        const hasDecimals = isNumber && (numValue % 1 !== 0 || label.includes('LTV') || label.includes('Yield'))

        return (
            <VStack align="stretch" spacing={0.5} mb={2}>
                <Text fontSize="9px" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px" lineHeight="1.2">
                    {label}
                </Text>
                <HStack spacing={1}>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.5 }}
                    >
                        <Text
                            fontSize="sm"
                            fontWeight="bold"
                            color={PRIMARY_PURPLE}
                            fontFamily="mono"
                            textShadow={`0 0 5px ${PRIMARY_PURPLE}`}
                            lineHeight="1.2"
                        >
                            {isNumber ? (
                                <AnimatedCounter value={numValue} decimals={hasDecimals ? 2 : 0} />
                            ) : (
                                value
                            )}
                        </Text>
                    </motion.div>
                    {unit && (
                        <Text fontSize="8px" color="whiteAlpha.500" fontFamily="mono" lineHeight="1.2">
                            {unit}
                        </Text>
                    )}
                </HStack>
                <Box
                    h="0.5px"
                    bgGradient={`linear(to-r, transparent, ${PRIMARY_PURPLE}, transparent)`}
                    opacity={0.5}
                    mt={0.5}
                />
            </VStack>
        )
    }

    return (
        <Box
            style={{ zoom: "111%" }}
            w="240px"
            bg="rgba(10, 10, 10, 0.95)"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            p={4}
            position="relative"
            borderRadius="md"
            boxShadow={`0 0 30px ${PRIMARY_PURPLE}40`}
        >
            {/* HUD Header */}
            <VStack align="stretch" mb={4}>
                <Text
                    fontSize="xs"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="mono"
                    letterSpacing="1px"
                    textTransform="uppercase"
                    mb={1}
                >
                    LTV Disco Metrics
                </Text>
                <Box h="1px" bg={PRIMARY_PURPLE} opacity={0.6} />
            </VStack>

            {/* Metrics */}
            <VStack align="stretch" spacing={0}>
                <MetricRow label="Total MBRN Deposited" value={totalDeposits} unit="MBRN" />
                <MetricRow label="Average LTV Exposure" value={averageLTV * 100} unit="%" />
                <MetricRow label="Active Tranches" value={activeTranches} />
                <MetricRow label="Total Insurance" value={totalInsurance} unit="CDT" />
                <MetricRow label="Yield Range" value={yieldRange} />
                <MetricRow label="Pending Revenue" value={pendingRevenue} unit="CDT" />
                <MetricRow label="Recent Liquidations (1h)" value={recentLiquidations} />
            </VStack>

            {/* HUD Grid Overlay */}
            <Box
                position="absolute"
                inset={0}
                pointerEvents="none"
                opacity={0.1}
                borderRadius="md"
                backgroundImage="linear-gradient(rgba(166, 146, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(166, 146, 255, 0.1) 1px, transparent 1px)"
                backgroundSize="10px 10px"
            />
        </Box>
    )
}

