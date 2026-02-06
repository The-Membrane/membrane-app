import React, { useMemo, useState } from 'react'
import { Box, Text, HStack, Checkbox } from '@chakra-ui/react'
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    CartesianGrid,
    Legend,
} from 'recharts'
import { MarketConditions } from '@/services/manic'

interface MarketConditionsChartProps {
    data: MarketConditions[]
    isLoading?: boolean
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload as MarketConditions & { netAPR: number; vaultAPR: number; vaultCost: number }
        const date = new Date(data.timestamp * 1000)
        const vaultAPR = data.vaultAPR
        const vaultCost = data.vaultCost
        const netAPR = data.netAPR

        return (
            <Box
                bg="#23252B"
                border="1px solid"
                borderColor="cyan.500"
                borderRadius="md"
                p={2}
                fontSize="xs"
            >
                <Text color="#F5F5F5" fontWeight="bold" mb={1}>
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </Text>
                <Text color="green.400">
                    Vault APR: {vaultAPR.toFixed(2)}%
                </Text>
                <Text color="#00D9FF" fontSize="xs">
                    Net Base APR: {netAPR.toFixed(2)}%
                </Text>
                <Text color="#FF6B6B" fontSize="xs">
                    Vault Cost: {vaultCost.toFixed(2)}%
                </Text>
            </Box>
        )
    }
    return null
}

export const MarketConditionsChart: React.FC<MarketConditionsChartProps> = ({ data, isLoading }) => {
    const [showNetOnly, setShowNetOnly] = useState(false)

    const chartData = useMemo(() => {
        console.log('[MarketConditionsChart] Received data:', data?.length || 0, 'entries, isLoading:', isLoading)
        console.log('[MarketConditionsChart] Data type:', typeof data, Array.isArray(data))
        console.log('[MarketConditionsChart] Data value:', data)
        if (!data || data.length === 0) {
            console.log('[MarketConditionsChart] No data available - data is:', data)
            return []
        }

        const transformed = data
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((mc) => {
                const vaultAPR = parseFloat(mc.vault_apr) * 100
                const vaultCost = parseFloat(mc.vault_cost) * 100
                const netAPR = vaultAPR - vaultCost

                return {
                    timestamp: mc.timestamp,
                    date: new Date(mc.timestamp * 1000).toLocaleDateString(),
                    vaultAPR,
                    vaultCost,
                    netAPR,
                }
            })
        console.log('[MarketConditionsChart] Transformed data:', transformed.length, 'entries')
        return transformed
    }, [data, isLoading])

    if (isLoading) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text fontSize="xs" color="#F5F5F540">Loading market conditions...</Text>
            </Box>
        )
    }

    if (chartData.length === 0) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text fontSize="xs" color="#F5F5F540">No market conditions data available</Text>
            </Box>
        )
    }

    return (
        <Box>
            {/* Radio Button Toggle */}
            <HStack justify="flex-end" mb={2}>
                <Checkbox
                    isChecked={showNetOnly}
                    onChange={(e) => setShowNetOnly(e.target.checked)}
                    colorScheme="cyan"
                    size="sm"
                >
                    <Text fontSize="xs" color="#F5F5F580" fontFamily="mono">
                        Net Base APR only
                    </Text>
                </Checkbox>
            </HStack>

            <Box h="200px" w="100%">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#6943FF20" />
                        <XAxis
                            dataKey="date"
                            tick={{ fill: '#F5F5F580', fontSize: 10 }}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            tick={{ fill: '#F5F5F580', fontSize: 10 }}
                            label={{ value: 'APR (%)', angle: -90, position: 'insideLeft', fill: '#F5F5F580' }}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Legend
                            wrapperStyle={{ fontSize: '10px', color: '#F5F5F580' }}
                        />

                        {!showNetOnly ? (
                            <>
                                <Line
                                    type="monotone"
                                    stroke="#48BB78"
                                    dataKey="vaultAPR"
                                    strokeWidth={2}
                                    dot={false}
                                    name="Vault APR"
                                />
                                <Line
                                    type="monotone"
                                    dataKey="netAPR"
                                    stroke="#00D9FF"
                                    strokeWidth={2}
                                    dot={false}
                                    name="Net Base APR"
                                />
                                <Line
                                    type="monotone"
                                    dataKey="vaultCost"
                                    stroke="#FF6B6B"
                                    strokeWidth={2}
                                    dot={false}
                                    name="Vault Cost"
                                />
                            </>
                        ) : (
                            <Line
                                type="monotone"
                                dataKey="netAPR"
                                stroke="#00D9FF"
                                strokeWidth={2}
                                dot={false}
                                name="Net Base APR"
                            />
                        )}
                    </LineChart>
                </ResponsiveContainer>
            </Box>
        </Box>
    )
}

