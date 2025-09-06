import React, { useMemo } from 'react'
import { Box, HStack, Text, VStack, Flex, Icon, Tooltip as ChakraTooltip } from '@chakra-ui/react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { BrainCircuit } from 'lucide-react'
import { JsonBrainProgressEntry } from '@/services/q-racing'

interface IQProgressChartProps {
    entries: JsonBrainProgressEntry[]
    currentStatesSeen: number
    currentWallCollisions: number
    carId?: string
}

interface ChartDataPoint {
    entry: number
    percentage: number
    statesSeen: number
    wallCollisions: number
    confidence: number
}

const IQProgressChart: React.FC<IQProgressChartProps> = ({
    entries,
    currentStatesSeen,
    currentWallCollisions,
    carId
}) => {
    const chartData = useMemo((): ChartDataPoint[] => {
        return entries.map((entry, index) => {
            const effectiveStatesSeen = entry.states_seen - entry.wall_collisions
            const percentage = (effectiveStatesSeen / 625) * 100
            return {
                entry: index + 1,
                percentage: Math.max(0, Math.min(100, percentage)),
                statesSeen: entry.states_seen,
                wallCollisions: entry.wall_collisions,
                confidence: entry.avg_confidence
            }
        })
    }, [entries])

    const currentPercentage = useMemo(() => {
        if (entries.length > 0) {
            const lastEntry = entries[entries.length - 1]
            const effectiveStatesSeen = lastEntry.states_seen - lastEntry.wall_collisions
            return Math.max(0, Math.min(100, (effectiveStatesSeen / 625) * 100))
        }
        return 0
    }, [entries])

    const currentStatesSeenCount = useMemo(() => {
        console.log('entries', entries.length)
        if (entries.length > 0) {
            return entries[entries.length - 1].states_seen
        }
        return 0
    }, [entries])

    const yAxisDomain = useMemo(() => {
        if (chartData.length === 0) return [0, 100]

        const maxPercentage = Math.max(...chartData.map(d => d.percentage))
        const minPercentage = Math.min(...chartData.map(d => d.percentage))

        // Add some padding (10% of the range) and ensure we don't go below 0
        const range = maxPercentage - minPercentage
        const padding = Math.max(range * 0.1, 5) // At least 5% padding

        const min = Math.max(0, minPercentage - padding)
        const max = Math.min(100, maxPercentage + padding)

        return [min, max]
    }, [chartData])

    const brainFillPercentage = currentPercentage / 100

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload as ChartDataPoint
            return (
                <Box
                    bg="#0a0f1e"
                    border="1px solid #2a3550"
                    borderRadius="4px"
                    p={2}
                    fontFamily='"Press Start 2P", monospace'
                    fontSize="10px"
                >
                    <Text color="#00ffea">Entry {data.entry}</Text>
                    <Text color="#b8c1ff">IQ: {data.percentage.toFixed(1)}%</Text>
                    <Text color="#ff6b6b">Confidence: {((data.confidence / 127) * 100).toFixed(1)}%</Text>
                    <Text color="#b8c1ff">States: {data.statesSeen}</Text>
                    <Text color="#b8c1ff">Walls: {data.wallCollisions}</Text>
                </Box>
            )
        }
        return null
    }

    return (
        <VStack align="stretch" spacing={3} h="100%">
            {/* Header with Brain Icon */}
            <Flex justify="space-between" align="center">
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize={{ base: '10px', sm: '12px' }}
                    color="#00ffea"
                >
                    IQ Progress
                </Text>
                <HStack spacing={4} fontSize="8px">
                    <HStack spacing={1}>
                        <Box w="12px" h="2px" bg="#00ffea" />
                        <Text color="#b8c1ff">IQ %</Text>
                    </HStack>
                    {/* <HStack spacing={1}>
                        <Box w="3px" h="3px" bg="#00ffea" borderRadius="50%" opacity={0.6} />
                        <Text color="#b8c1ff">Low confidence</Text>
                    </HStack>
                    <HStack spacing={1}>
                        <Box w="8px" h="8px" bg="#00ffea" borderRadius="50%" opacity={1} />
                        <Text color="#b8c1ff">High confidence</Text>
                    </HStack> */}
                </HStack>
                <HStack spacing={2}>
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="10px"
                        color="#b8c1ff"
                    >
                        {currentPercentage.toFixed(1)}%
                    </Text>
                    <ChakraTooltip
                        label={`${currentStatesSeenCount} / 625 states seen`}
                        placement="top"
                        hasArrow
                        bg="#0a0f1e"
                        color="#00ffea"
                        border="1px solid #2a3550"
                        borderRadius="4px"
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="10px"
                        px={2}
                        py={1}
                    >
                        <Box position="relative" w="24px" h="24px" cursor="pointer">
                            <Icon
                                as={BrainCircuit}
                                w="24px"
                                h="24px"
                                color="#2a3550"
                            />
                            <Box
                                position="absolute"
                                top="0"
                                left="0"
                                w="24px"
                                h="24px"
                                overflow="hidden"
                                style={{
                                    clipPath: `inset(${100 - (brainFillPercentage * 100)}% 0 0 0)`
                                }}
                            >
                                <Icon
                                    as={BrainCircuit}
                                    w="24px"
                                    h="24px"
                                    color="#00ffea"
                                />
                            </Box>
                        </Box>
                    </ChakraTooltip>
                </HStack>
            </Flex>

            {/* Chart */}
            <Box flex="1" minH="200px" w="100%">
                {chartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                            <XAxis
                                dataKey="entry"
                                tick={{ fontSize: 8, fill: '#b8c1ff', fontFamily: '"Press Start 2P", monospace' }}
                                axisLine={{ stroke: '#2a3550' }}
                                tickLine={{ stroke: '#2a3550' }}
                            />
                            <YAxis
                                domain={yAxisDomain}
                                tick={{ fontSize: 8, fill: '#b8c1ff', fontFamily: '"Press Start 2P", monospace' }}
                                axisLine={{ stroke: '#2a3550' }}
                                tickLine={{ stroke: '#2a3550' }}
                                tickFormatter={(value) => `${value.toFixed(1)}%`}
                            />
                            <Tooltip content={<CustomTooltip />} />
                            <Line
                                type="monotone"
                                dataKey="percentage"
                                stroke="#00ffea"
                                strokeWidth={2}
                                dot={false}
                                activeDot={false}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <Flex
                        align="center"
                        justify="center"
                        h="100%"
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="10px"
                        color="#666"
                    >
                        No training data
                    </Flex>
                )}
            </Box>

            {/* Stats */}
            <HStack justify="space-between" fontSize="8px" color="#b8c1ff" fontFamily='"Press Start 2P", monospace'>
                <Text>Entries: {chartData.length}</Text>
                <Text>Max: 625 states</Text>
            </HStack>
        </VStack>
    )
}

export default IQProgressChart
