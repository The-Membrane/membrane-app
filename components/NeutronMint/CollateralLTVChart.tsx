import { Box, Text } from '@chakra-ui/react'
import { MockLTVSnapshot } from './mockCollateralData'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { lazyChart } from '@/components/ui/lazyChart'

const LTVChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <Box bg="rgba(10,10,10,0.95)" border="1px solid" borderColor="whiteAlpha.200" borderRadius="md" px={2} py={1}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
        {new Date(label * 1000).toLocaleDateString()}
      </Text>
      <Text fontSize={TYPOGRAPHY.small} color="white" fontWeight={TYPOGRAPHY.medium}>
        {payload[0].value.toFixed(2)}%
      </Text>
    </Box>
  )
}

interface LTVHistoryChartProps {
  chartData: MockLTVSnapshot[]
  maxLTV: number
  pendingLTV: number
}

export const LTVHistoryChart = lazyChart<LTVHistoryChartProps>(
  ({ LineChart, Line, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, ReferenceLine, CartesianGrid }) =>
    function LTVHistoryChart({ chartData, maxLTV, pendingLTV }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[(dataMin: number) => Math.floor(dataMin - 5), (dataMax: number) => Math.ceil(dataMax + 5)]}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              width={50}
            />
            <RechartsTooltip content={<LTVChartTooltip />} />
            {/* Liquidation LTV reference */}
            <ReferenceLine
              y={maxLTV}
              stroke={SEMANTIC_COLORS.danger}
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: 'Liq', fill: SEMANTIC_COLORS.danger, fontSize: 9, position: 'right' }}
            />
            {/* Pending target LTV reference */}
            <ReferenceLine
              y={pendingLTV}
              stroke={SEMANTIC_COLORS.warning}
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: 'Target', fill: SEMANTIC_COLORS.warning, fontSize: 9, position: 'right' }}
            />
            <Line
              type="monotone"
              dataKey="ltv"
              stroke={SEMANTIC_COLORS.info}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: SEMANTIC_COLORS.info }}
            />
            <Line
              type="stepAfter"
              dataKey="currentLtv"
              stroke="white"
              strokeWidth={1}
              dot={false}
              activeDot={{ r: 2, fill: 'white' }}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  '140px',
)
