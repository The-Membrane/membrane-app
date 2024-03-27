import { TxButton } from '@/components/TxButton'
import { isGreaterThanZero } from '@/helpers/num'
import { Card, HStack, Stack, Text } from '@chakra-ui/react'
import { Cell, Label, Pie, PieChart } from 'recharts'
import useClaim from './hooks/useClaim'
import { useIncentives, useRanking } from './hooks/useLockdrop'

const data = [{ name: 'Group A', value: 400 }]
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042']

const Chart = () => {
  return (
    <Stack w="full" alignItems="center">
      <PieChart width={300} height={300}>
        <Pie
          data={data}
          cx={140}
          cy={145}
          innerRadius={110}
          outerRadius={140}
          fill="#8884d8"
          dataKey="value"
          startAngle={90}
          endAngle={-270}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
          <Label value="100%" position="center" fill="#fff" fontSize="24px" />
        </Pie>
      </PieChart>
    </Stack>
  )
}

const LockChart = () => {
  const claim = useClaim()
  const { data: incentives } = useIncentives()
  const { data: distribution } = useRanking()

  return (
    <Card>
      <Text variant="title" fontSize="24px">
        Vesting
      </Text>
      <Chart />

      <HStack w="full" alignSelf="center">
        <Stack w="full" gap="0">
          <Text variant="label" fontSize="xl">
            {incentives?.amount} MBRN
          </Text>
          <Text fontSize="xs" color="gray">
            Rank: {distribution?.userRanking} / {distribution?.totalRanking}
          </Text>
        </Stack>

        <TxButton
          isDisabled={!isGreaterThanZero(incentives?.amount)}
          w="310px"
          isLoading={claim.isPending}
          onClick={() => claim.mutate()}
        >
          Claim
        </TxButton>
      </HStack>
    </Card>
  )
}

export default LockChart
