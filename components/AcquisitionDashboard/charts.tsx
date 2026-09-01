import React from 'react'
import { lazyChart } from '@/components/ui/lazyChart'
import { CHART_THEME, ASSET_COLORS } from '@/config/chartTheme'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

// Series colors — Living Typeface chart palette.
const SUPPLY_COLOR = ASSET_COLORS[1]     // cyber teal — machine-side supply data
const BURNED_COLOR = ASSET_COLORS[3]     // blood red — burns/down
const UTILIZATION_COLOR = ASSET_COLORS[0] // phosphor — health metric
const RATE_COLOR = ASSET_COLORS[1]       // cyber teal — machine-side rate
const BUMP_COLOR = ASSET_COLORS[2]       // gold — bump/caution
const POOL_COLOR = ASSET_COLORS[0]       // phosphor — accrued pool (primary emphasis)
const DEPOSITS_COLOR = ASSET_COLORS[1]   // cyber teal — deposits
const EFFICIENCY_COLOR = ASSET_COLORS[2] // gold — efficiency

/* ── Supply history chart (LineChart + Brush/AreaChart) ── */
export const SupplyHistoryChart = lazyChart<{ data: any[] }>(
  ({ LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, Brush }) =>
    function SupplyHistoryChart({ data }) {
      return (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data}>
            <XAxis
              dataKey="date"
              {...CHART_THEME.axis}
              interval="preserveStartEnd"
              tickFormatter={(value, index) => {
                if (data.length === 0) return value
                const step = Math.max(1, Math.floor(data.length / 6))
                if (index === 0 || index === data.length - 1 || index % step === 0) {
                  return value
                }
                return ''
              }}
            />
            <YAxis
              {...CHART_THEME.axis}
              tickFormatter={(value: number) => {
                if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
                if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`
                if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
                return value.toString()
              }}
            />
            <RechartsTooltip
              {...CHART_THEME.tooltip}
              formatter={(value: any, name: string) => {
                const formatted = Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })
                const label = name === 'currentSupply' ? 'Current Supply' : 'Burned'
                return [`${formatted} MBRN`, label]
              }}
              labelFormatter={(label) => label}
            />
            <Line
              type="monotone"
              dataKey="currentSupply"
              stroke={SUPPLY_COLOR}
              strokeWidth={2}
              dot={false}
              name="currentSupply"
            />
            <Line
              type="monotone"
              dataKey="burnedSupply"
              stroke={BURNED_COLOR}
              strokeWidth={2}
              dot={false}
              name="burnedSupply"
            />
            <Brush
              dataKey="date"
              height={40}
              stroke={SEMANTIC_COLORS.borderStrong}
              fill={SEMANTIC_COLORS.bgSecondary}
              travellerWidth={10}
              tickFormatter={() => ''}
            >
              <AreaChart data={data}>
                <Area
                  type="monotone"
                  dataKey="currentSupply"
                  stroke={SUPPLY_COLOR}
                  fill={SUPPLY_COLOR}
                  fillOpacity={0.2}
                  strokeWidth={1}
                />
              </AreaChart>
            </Brush>
          </LineChart>
        </ResponsiveContainer>
      )
    },
  300,
)

/* ── Utilization, acquisition rate & bump rate chart ── */
export const UtilizationRateChart = lazyChart<{ data: any[] }>(
  ({ LineChart, Line, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer }) =>
    function UtilizationRateChart({ data }) {
      return (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data}>
            <XAxis
              dataKey="date"
              {...CHART_THEME.axis}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="pct"
              {...CHART_THEME.axis}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              domain={[0, 100]}
            />
            <YAxis
              yAxisId="rate"
              orientation="right"
              {...CHART_THEME.axis}
              strokeOpacity={0.4}
              tickFormatter={(v: number) => v.toFixed(2)}
            />
            <RechartsTooltip
              {...CHART_THEME.tooltip}
              formatter={(value: any, name: string) => {
                if (name === 'utilization') return [`${Number(value).toFixed(1)}%`, 'Utilization']
                if (name === 'rate') return [Number(value).toFixed(4), 'Acquisition Rate']
                return [Number(value).toFixed(4), 'Bump Rate']
              }}
            />
            <Line yAxisId="pct" type="monotone" dataKey="utilization" stroke={UTILIZATION_COLOR} strokeWidth={2} dot={false} name="utilization" />
            <Line yAxisId="rate" type="monotone" dataKey="rate" stroke={RATE_COLOR} strokeWidth={2} dot={false} name="rate" />
            <Line yAxisId="rate" type="monotone" dataKey="bumpRate" stroke={BUMP_COLOR} strokeWidth={2} dot={false} name="bumpRate" />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  280,
)

/* ── Accrued pool, new deposits & efficiency chart ── */
export const AccruedPoolChart = lazyChart<{ data: any[] }>(
  ({ AreaChart, Area, Line, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer }) =>
    function AccruedPoolChart({ data }) {
      return (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data}>
            <XAxis
              dataKey="date"
              {...CHART_THEME.axis}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="amount"
              {...CHART_THEME.axis}
              tickFormatter={(v: number) => {
                if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
                if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
                return v.toString()
              }}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              {...CHART_THEME.axis}
              strokeOpacity={0.4}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              domain={[0, 100]}
            />
            <RechartsTooltip
              {...CHART_THEME.tooltip}
              formatter={(value: any, name: string) => {
                if (name === 'accruedPool') return [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} MBRN`, 'Accrued Pool']
                if (name === 'newDeposits') return [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} CDT`, 'New Deposits']
                if (value === null) return ['N/A', 'Efficiency']
                return [`${Number(value).toFixed(1)}%`, 'Efficiency']
              }}
            />
            <Area
              yAxisId="amount"
              type="monotone"
              dataKey="accruedPool"
              stroke={POOL_COLOR}
              fill={POOL_COLOR}
              fillOpacity={0.15}
              strokeWidth={2}
              name="accruedPool"
            />
            <Area
              yAxisId="amount"
              type="monotone"
              dataKey="newDeposits"
              stroke={DEPOSITS_COLOR}
              fill={DEPOSITS_COLOR}
              fillOpacity={0.1}
              strokeWidth={2}
              name="newDeposits"
            />
            <Line yAxisId="pct" type="monotone" dataKey="efficiency" stroke={EFFICIENCY_COLOR} strokeWidth={2} dot={false} name="efficiency" connectNulls />
          </AreaChart>
        </ResponsiveContainer>
      )
    },
  280,
)
