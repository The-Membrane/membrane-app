import React, { useMemo, useState } from 'react'
import { Box, Text, HStack, Checkbox } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CHART_THEME } from '@/config/chartTheme'
import { lazyChart } from '@/components/ui/lazyChart'
import { MarketConditions } from '@/services/manic'

// Living Typeface series colors for this chart: phosphor = vault APR (the
// positive/organic series), cyber teal = net base APR (machine-side), blood =
// vault cost (the drag). No legacy cyan or purple in this chart.
const SERIES_VAULT_APR = SEMANTIC_COLORS.success
const SERIES_NET_APR = SEMANTIC_COLORS.info
const SERIES_VAULT_COST = SEMANTIC_COLORS.danger

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
                bg={SEMANTIC_COLORS.bgSecondary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderStrong}
                borderRadius={0}
                p={SPACING.sm}
                fontSize={TYPOGRAPHY.xs}
                fontFamily={TYPOGRAPHY.fontMono}
                sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold} mb={SPACING.xs}>
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </Text>
                <Text color={SERIES_VAULT_APR}>
                    Vault APR: {vaultAPR.toFixed(2)}%
                </Text>
                <Text color={SERIES_NET_APR} fontSize={TYPOGRAPHY.xs}>
                    Net Base APR: {netAPR.toFixed(2)}%
                </Text>
                <Text color={SERIES_VAULT_COST} fontSize={TYPOGRAPHY.xs}>
                    Vault Cost: {vaultCost.toFixed(2)}%
                </Text>
            </Box>
        )
    }
    return null
}

type MarketConditionsPoint = {
    timestamp: number
    date: string
    vaultAPR: number
    vaultCost: number
    netAPR: number
}

const MarketConditionsLineChart = lazyChart<{ chartData: MarketConditionsPoint[]; showNetOnly: boolean }>(
    ({ LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip: RechartsTooltip, CartesianGrid, Legend }) =>
        function MarketConditionsLineChart({ chartData, showNetOnly }) {
            return (
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} />
                        <XAxis
                            dataKey="date"
                            tick={{ fill: SEMANTIC_COLORS.textSecondary, fontSize: 10 }}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            tick={{ fill: SEMANTIC_COLORS.textSecondary, fontSize: 10 }}
                            label={{ value: 'APR (%)', angle: -90, position: 'insideLeft', fill: SEMANTIC_COLORS.textSecondary }}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Legend
                            wrapperStyle={{ fontSize: '10px', color: SEMANTIC_COLORS.textSecondary }}
                        />

                        {!showNetOnly ? (
                            <>
                                <Line
                                    type="monotone"
                                    stroke={SERIES_VAULT_APR}
                                    dataKey="vaultAPR"
                                    strokeWidth={2}
                                    dot={false}
                                    name="Vault APR"
                                />
                                <Line
                                    type="monotone"
                                    dataKey="netAPR"
                                    stroke={SERIES_NET_APR}
                                    strokeWidth={2}
                                    dot={false}
                                    name="Net Base APR"
                                />
                                <Line
                                    type="monotone"
                                    dataKey="vaultCost"
                                    stroke={SERIES_VAULT_COST}
                                    strokeWidth={2}
                                    dot={false}
                                    name="Vault Cost"
                                />
                            </>
                        ) : (
                            <Line
                                type="monotone"
                                dataKey="netAPR"
                                stroke={SERIES_NET_APR}
                                strokeWidth={2}
                                dot={false}
                                name="Net Base APR"
                            />
                        )}
                    </LineChart>
                </ResponsiveContainer>
            )
        },
    '200px',
)

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
                    date: new Date(mc.timestamp * 1000).toLocaleDateString('en-US', { timeZone: 'UTC' }),
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
                <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    fontFamily={TYPOGRAPHY.fontMono}
                >
                    Loading market conditions...
                </Text>
            </Box>
        )
    }

    if (chartData.length === 0) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    fontFamily={TYPOGRAPHY.fontMono}
                >
                    No market conditions data available
                </Text>
            </Box>
        )
    }

    return (
        <Box>
            {/* Radio Button Toggle */}
            <HStack justify="flex-end" mb={SPACING.sm}>
                <Checkbox
                    isChecked={showNetOnly}
                    onChange={(e) => setShowNetOnly(e.target.checked)}
                    size="sm"
                    transition={TRANSITIONS.colors}
                    _focus={FOCUS_STYLES.ring}
                    sx={{
                        '& .chakra-checkbox__control': {
                            borderRadius: 0,
                            borderColor: SEMANTIC_COLORS.borderStrong,
                        },
                        '& .chakra-checkbox__control[data-checked]': {
                            bg: SEMANTIC_COLORS.primary,
                            borderColor: SEMANTIC_COLORS.primary,
                            color: SEMANTIC_COLORS.bgPrimary,
                        },
                    }}
                >
                    <Text
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textSecondary}
                        fontFamily={TYPOGRAPHY.fontMono}
                    >
                        Net Base APR only
                    </Text>
                </Checkbox>
            </HStack>

            <Box h="200px" w="100%">
                <MarketConditionsLineChart chartData={chartData} showNetOnly={showNetOnly} />
            </Box>
        </Box>
    )
}
