import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { Box, HStack, Spinner, Stack, Text, useBreakpointValue } from '@chakra-ui/react'
import { useMemo } from 'react'
import { Bar, BarChart, Cell, Rectangle, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import useBidState from './hooks/useBidState'
import { useCapitalAheadOfDeposit, useLiquidation, useStabilityAssetPool } from '@/hooks/useLiquidations'

const CustomTooltip = ({ active, payload, label }) => {
  const { tvl, premium, capitalAheadAmount } = payload[0]?.payload || {}

  if (active && payload && payload.length) {
    return (
      <Stack bg="black" p={4} borderRadius="md" minW="200px">
        <HStack
          justifyContent="space-between"
          borderBottom="1px solid"
          borderColor="whiteAlpha.300"
          pb={1}
        >
          <Text fontSize="xs" color="whiteAlpha.600">
            TVL
          </Text>
          <Text fontSize="xs" color="whiteAlpha.800">
            {tvl} CDT
          </Text>
        </HStack>
        {premium === 10 ? (
          <HStack justifyContent="space-between">
            <Text fontSize="xs" color="whiteAlpha.600">
              Capital Ahead
            </Text>
            <Text fontSize="xs" color="whiteAlpha.800">
              {capitalAheadAmount}
            </Text>
          </HStack>
        ) : (
          <HStack justifyContent="space-between">
            <Text fontSize="xs" color="whiteAlpha.600">
              Premium
            </Text>
            <Text fontSize="xs" color="whiteAlpha.800">
              {label}%
            </Text>
          </HStack>
        )}
      </Stack>
    )
  }

  return null
}

// Custom Tick component
const CustomTick = ({ x, y, payload, bidState, onClick }) => {
  // Check if this tick needs restyling
  const isSpecialTick = payload.value === 10;

  return (
    <g transform={`translate(${x},${y})`}>
      {/* Restyle the tick based on the condition */}
      <text x={0} y={0} dy={11} textAnchor="middle" fill={payload.value === bidState.placeBid.premium ? "#00A3F9" : isSpecialTick ? '#C445F0' : '#FFF'} fontSize={16} onClick={() => { onClick(payload.value) }} cursor={"pointer"}>
        {payload.value}
      </text>
    </g>
  );
};

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

  //Save the indices of the LQ Slots that users are deposited in
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
  }, [liqudation])

  if (isLoading) {
    return (
      <Box w="420px" h="180px" display="flex" justifyContent="center" alignItems="center">
        <Spinner color="primary.200" />
      </Box>
    )
  }

  return (
    <Box w="420px" h="200px">
      <ResponsiveContainer style={{justifySelf: "center"}} width={isMobile ? "86%" : "100%" } height="100%">
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
              <stop offset="0%" stopColor="#00A3F9" />
              <stop offset="100%" stopColor="#00F1EF" />
            </linearGradient>

            <linearGradient id="goldTVL" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e9f339" />
              <stop offset="100%" stopColor="#00F1EF" />
            </linearGradient>

            <linearGradient id="userTVL" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e9f339" />
              <stop offset="100%" stopColor="#C445F0" />
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
                key={`cell-${index}`}
                fill={
                  index === 10
                    ? 'url(#goldTVL)'
                    : userBidIndices?.includes(index)
                      ? 'url(#userTVL)'
                      : 'url(#colorTVL)'
                }
              />
            ))}
          </Bar>

          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'none' }} />
          <XAxis
            dataKey="premium"
            tick={({ x, y, payload }) => (
              <CustomTick x={x} y={y} payload={payload} bidState={bidState} onClick={onPremiumChange} />
            )}
            tickMargin={10}
            axisLine={{ stroke: '#FFF' }}
            tickLine={false}
            height={50}
            label={{
              value: 'Premium %',
              position: 'insideBottom',
              offset: -5,
              fill: 'gray',
              fontSize: 13,
            }}
          />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  )
}

export default RiskChart
