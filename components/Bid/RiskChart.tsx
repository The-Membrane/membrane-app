import { Box, Spinner } from '@chakra-ui/react'
import { Bar, BarChart, Rectangle, ResponsiveContainer, XAxis } from 'recharts'
import useLiquidation from './hooks/useLiquidation'
import { useMemo } from 'react'
import { num } from '@/helpers/num'
import useBidState from './hooks/useBidState'
import { shiftDigits } from '@/helpers/math'

// const data = [
//   {
//     name: '1',
//     uv: 4000,
//   },
//   {
//     name: '2',
//     uv: 3000,
//   },
//   {
//     name: '3',
//     uv: 2000,
//   },
//   {
//     name: '4',
//     uv: 2780,
//   },
//   {
//     name: '5',
//     uv: 1890,
//   },
// ]

const RiskChart = () => {
  const { bidState } = useBidState()
  const { data: liqudation, isLoading } = useLiquidation(bidState?.selectedAsset)

  const data = useMemo(() => {
    return liqudation
      ?.map((item, index) => {
        return {
          name: num(item?.liq_premium).times(100).toNumber(),
          bid: shiftDigits(item?.total_bid_amount, 7),
        }
      })
      .slice(0, 10)
  }, [liqudation])

  if (isLoading) {
    return (
      <Box w="420px" h="180px" display="flex" justifyContent="center" alignItems="center">
        <Spinner color="primary.200" />
      </Box>
    )
  }

  return (
    <Box w="420px" h="180px">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          width={420}
          height={180}
          data={data}
          margin={{
            bottom: 5,
          }}
        >
          <defs>
            <linearGradient id="colorBid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00A3F9" />
              <stop offset="100%" stopColor="#00F1EF" />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="name"
            tick={{ fill: '#FFF' }}
            tickMargin={15}
            axisLine={{ stroke: '#FFF' }}
            tickLine={false}
          />
          <Bar
            dataKey="bid"
            fill="url(#colorBid)"
            barSize={24}
            shape={<Rectangle radius={[10, 10, 0, 0]} />}
          />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  )
}

export default RiskChart
