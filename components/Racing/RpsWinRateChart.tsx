import React, { useMemo } from 'react'
import { Box, HStack, Text, VStack, Flex, Tooltip as ChakraTooltip } from '@chakra-ui/react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { Trophy } from 'lucide-react'
interface RpsWinRateChartProps {
    matchHistory: number[] // Array of outcomes: 0=lose, 1=draw, 2=win
    carId?: string
}

interface ChartDataPoint {
    tick: number
    winRate: number
    wins: number
    total: number
}

const RpsWinRateChart: React.FC<RpsWinRateChartProps> = ({
    matchHistory,
    carId
}) => {
    const chartData = useMemo((): ChartDataPoint[] => {
        if (matchHistory.length === 0) return []

        return matchHistory.map((outcome, index) => {
            const tickNumber = index + 1
            const wins = matchHistory.slice(0, tickNumber).filter(o => o === 2).length
            const total = tickNumber
            const winRate = total > 0 ? (wins / total) * 100 : 0

            return {
                tick: tickNumber,
                winRate: Math.round(winRate * 10) / 10, // Round to 1 decimal place
                wins,
                total
            }
        })
    }, [matchHistory])

    const currentWinRate = useMemo(() => {
        if (chartData.length === 0) return 0
        return chartData[chartData.length - 1].winRate
    }, [chartData])

    const yAxisDomain = useMemo(() => {
        if (chartData.length === 0) return [0, 100]

        const maxWinRate = Math.max(...chartData.map(d => d.winRate))
        const minWinRate = Math.min(...chartData.map(d => d.winRate))

        // Add some padding and ensure we don't go below 0 or above 100
        const range = maxWinRate - minWinRate
        const padding = Math.max(range * 0.1, 5) // At least 5% padding

        const min = Math.max(0, minWinRate - padding)
        const max = Math.min(100, maxWinRate + padding)

        return [min, max]
    }, [chartData])

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
                    <Text color="#00ffea">Tick {data.tick}</Text>
                    <Text color="#b8c1ff">Win Rate: {data.winRate.toFixed(1)}%</Text>
                    <Text color="#b8c1ff">Wins: {data.wins}/{data.total}</Text>
                </Box>
            )
        }
        return null
    }

    return (
        <VStack align="stretch" spacing={3} h="100%">
            {/* Header with Trophy Icon */}
            <Flex justify="space-between" align="center">
                <Text
                    fontFamily='"Press Start 2P", monospace'
                    fontSize={{ base: '10px', sm: '12px' }}
                    color="#00ffea"
                >
                    RPS Win Rate
                </Text>
                <HStack spacing={4} fontSize="8px">
                    <HStack spacing={1}>
                        <Box w="12px" h="2px" bg="#00ffea" />
                        <Text color="#b8c1ff">Win Rate %</Text>
                    </HStack>
                </HStack>
                <HStack spacing={2}>
                    <Text
                        fontFamily='"Press Start 2P", monospace'
                        fontSize="10px"
                        color="#b8c1ff"
                    >
                        {currentWinRate.toFixed(1)}%
                    </Text>
                    <ChakraTooltip
                        label={`${chartData.length > 0 ? chartData[chartData.length - 1].wins : 0} wins out of ${chartData.length} ticks`}
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
                            <Trophy
                                size={24}
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
                                    clipPath: `inset(${100 - (currentWinRate / 100 * 100)}% 0 0 0)`
                                }}
                            >
                                <Trophy
                                    size={24}
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
                                dataKey="tick"
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
                                dataKey="winRate"
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
                        No RPS data
                    </Flex>
                )}
            </Box>

            {/* Stats */}
            <HStack justify="space-between" fontSize="8px" color="#b8c1ff" fontFamily='"Press Start 2P", monospace'>
                <Text>Ticks: {chartData.length}</Text>
                <Text>Current: {currentWinRate.toFixed(1)}%</Text>
            </HStack>
        </VStack>
    )
}

export default RpsWinRateChart
