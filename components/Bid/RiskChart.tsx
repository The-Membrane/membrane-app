import { Box } from '@chakra-ui/react'
import { Bar, BarChart, Rectangle, ResponsiveContainer, XAxis } from 'recharts'

const data = [
  {
    name: '1',
    uv: 4000,
  },
  {
    name: '2',
    uv: 3000,
  },
  {
    name: '3',
    uv: 2000,
  },
  {
    name: '4',
    uv: 2780,
  },
  {
    name: '5',
    uv: 1890,
  },
]

const RiskChart = () => {
  return (
    <Box w="420px" h="180px">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          width={420}
          height={180}
          data={data}
          margin={{
            top: 5,
            right: 50,
            left: 50,
            bottom: 5,
          }}
        >
          <defs>
            <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
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
            dataKey="uv"
            fill="url(#colorUv)"
            barSize={24}
            shape={<Rectangle radius={[10, 10, 0, 0]} />}
          />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  )
}

export default RiskChart
