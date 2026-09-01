import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { Box, HStack, Spinner, Stack, Text, useBreakpointValue } from '@chakra-ui/react'
import { useMemo } from 'react'
import { lazyChart } from '@/components/ui/lazyChart'
import useBidState from './hooks/useBidState'
import { useCapitalAheadOfDeposit, useLiquidation, useStabilityAssetPool } from '@/hooks/useLiquidations'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// recharts injects these props at render time. `payload` stays `any` because the
// recharts module is lazy-loaded here (see lazyChart), so its Payload type is not
// statically importable; each row carries the chart datum under `.payload`.
const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: any; label?: number }) => {
  const { tvl, premium, capitalAheadAmount } = payload[0]?.payload || {}

  if (active && payload && payload.length) {
    return (
      <Stack
        bg="rgba(10, 10, 10, 0.95)"
        p={SPACING.base}
        borderRadius="md"
        minW="200px"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderMedium}
      >
        <HStack
          justifyContent="space-between"
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderMedium}
          pb={SPACING.xs}
        >
          <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            TVL
          </Text>
          <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
            {tvl} CDT
          </Text>
        </HStack>
        {premium === 10 ? (
          <HStack justifyContent="space-between">
            <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              Capital Ahead
            </Text>
            <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
              {capitalAheadAmount}
            </Text>
          </HStack>
        ) : (
          <HStack justifyContent="space-between">
            <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              Premium
            </Text>
            <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
              {label}%
            </Text>
          </HStack>
        )}
      </Stack>
    )
  }

  return null
}

const CustomTick = ({
  x,
  y,
  payload,
  bidState,
  onClick,
}: {
  x: number
  y: number
  payload: { value: number }
  bidState: { placeBid: { premium: number } }
  onClick: (value: number) => void
}) => {
  const isSpecialTick = payload.value === 10
  const isSelected = payload.value === bidState.placeBid.premium

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={11}
        textAnchor="middle"
        fill={isSelected ? SEMANTIC_COLORS.success : isSpecialTick ? SEMANTIC_COLORS.primary : '#ece6d8'}
        fontSize={16}
        onClick={() => { onClick(payload.value) }}
        cursor="pointer"
      >
        {payload.value}
      </text>
    </g>
  )
}

const BidRiskChart = lazyChart<{
  data: any[] | undefined
  userBidIndices: (number | undefined)[] | undefined
  bidState: any
  onPremiumChange: (value: number) => void
  isMobile: boolean | undefined
}>(
  ({ Bar, BarChart, Cell, Rectangle, ResponsiveContainer, Tooltip: RechartsTooltip, XAxis }) =>
    function BidRiskChart({ data, userBidIndices, bidState, onPremiumChange, isMobile }) {
      const userBidIndexSet = new Set(userBidIndices)
      return (
        <ResponsiveContainer style={{ justifySelf: "center" }} width={isMobile ? "86%" : "100%"} height="100%">
          <BarChart
            width={420}
            height={200}
            data={data}
            margin={{
              bottom: 5,
            }}
          >
            <defs>
              <linearGradient id="colorTVL" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#46d39a" />
                <stop offset="100%" stopColor="#46d39a" />
              </linearGradient>

              <linearGradient id="goldTVL" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#46d39a" />
              </linearGradient>

              <linearGradient id="userTVL" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#9bdc4f" />
              </linearGradient>
            </defs>

            <Bar
              dataKey="tvl"
              fill="url(#goldTVL)"
              barSize={24}
              shape={<Rectangle radius={[10, 10, 0, 0]} />}
            >
              {data?.map((entry, index) => (
                <Cell
                  key={`cell-${entry.premium}`}
                  fill={
                    index === 10
                      ? 'url(#goldTVL)'
                      : userBidIndexSet.has(index)
                        ? 'url(#userTVL)'
                        : 'url(#colorTVL)'
                  }
                />
              ))}
            </Bar>

            <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: 'none' }} />
            <XAxis
              dataKey="premium"
              tick={({ x, y, payload }) => (
                <CustomTick x={x} y={y} payload={payload} bidState={bidState} onClick={onPremiumChange} />
              )}
              tickMargin={10}
              axisLine={{ stroke: '#ece6d8' }}
              tickLine={false}
              height={50}
              label={{
                value: 'Premium %',
                position: 'insideBottom',
                offset: -5,
                fill: SEMANTIC_COLORS.textTertiary,
                fontSize: 13,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      )
    },
  200,
)

const RiskChart = () => {
  const { address } = useWallet()
  const { bidState, setBidState } = useBidState()
  const { data: liqudation, isLoading } = useLiquidation(bidState?.selectedAsset)
  const { data: stabilityPoolAssets } = useStabilityAssetPool(true)
  const { data: capitalAheadAmount = 0 } = useCapitalAheadOfDeposit()
  const isMobile = useBreakpointValue({ base: true, md: false })

  const onPremiumChange = (value: number) => {
    const existingBid = bidState?.placeBid || {}
    const placeBid = {
      ...existingBid,
      premium: value,
    }
    setBidState({ ...bidState, placeBid })
  }

  var userBidIndices = liqudation?.map((slot) => {
    if (slot.bids.find((bid) => bid.user == (address as string)) != undefined) {
      return parseInt(slot.liq_premium) * 10
    } else {
      return -1
    }
  })

  const stabilityPoolAmount = stabilityPoolAssets?.credit_asset.amount || 0

  const data = useMemo(() => {
    const chartData = liqudation
      ?.map((item) => ({
        premium: num(item?.liq_premium).times(100).toNumber(),
        tvl: shiftDigits(item?.total_bid_amount, -6).toNumber(),
      }))
      .reverse()
      .sort((a, b) => a.premium - b.premium)
      .slice(0, 10)

    chartData?.push({
      capitalAheadAmount,
      premium: 10,
      tvl: shiftDigits(stabilityPoolAmount, -6).toNumber(),
    })

    return chartData
  }, [liqudation, capitalAheadAmount, stabilityPoolAmount])

  if (isLoading) {
    return (
      <Box w="420px" h="180px" display="flex" justifyContent="center" alignItems="center">
        <Spinner color={SEMANTIC_COLORS.primary} />
      </Box>
    )
  }

  return (
    <Box w="420px" h="200px">
      <BidRiskChart
        data={data}
        userBidIndices={userBidIndices}
        bidState={bidState}
        onPremiumChange={onPremiumChange}
        isMobile={isMobile}
      />
    </Box>
  )
}

export default RiskChart
