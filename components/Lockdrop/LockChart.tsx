import { TxButton } from '@/components/TxButton'
import { isGreaterThanZero, num } from '@/helpers/num'
import { Card, HStack, Stack, Text } from '@chakra-ui/react'
import { Cell, Label, Pie, PieChart } from 'recharts'
import useClaim from './hooks/useClaim'
import {
  useIncentives,
  useLockdrop,
  useLockdropClient,
  useRanking,
  useUserInfo,
} from './hooks/useLockdrop'

const data = [{ name: 'Group A', value: 400 }]
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042']
const SECONDS_IN_DAY = 86400

const Chart = () => {
  const { data: lockdrop } = useLockdrop()
  const { data: lockdropClient } = useLockdropClient()
  const { data: userInfo } = useUserInfo()

  var pieValue = 1
  var endTime = lockdrop?.withdrawal_end
  var currentTime = 0

  lockdropClient?.client.getBlock().then((block) => {
    currentTime = Date.parse(block.header.time) / 1000

    var progress = userInfo?.lockups.map((deposit) => {
      if (deposit.deposit != '') {
        var ratio =
          (deposit.deposit * (deposit.lockUpDuration + 1)) /
          (parseInt(userInfo?.total_tickets) / 1_000000)
        var time_left =
          (deposit.lockUpDuration + 1) * SECONDS_IN_DAY - (currentTime - (endTime ?? 0))
        if (time_left < 0) {
          time_left = 0
        }
        return (1 - time_left / ((deposit.lockUpDuration + 1) * SECONDS_IN_DAY)) * ratio
      } else {
        return 0
      }
    })

    if (progress) pieValue = progress?.reduce((a, b) => a + b, 0)
  })

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
          endAngle={90 - 360 * pieValue}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
          <Label
            value={(pieValue * 100).toString() + '%'}
            position="center"
            fill="#fff"
            fontSize="24px"
          />
        </Pie>
      </PieChart>
    </Stack>
  )
}

const LockChart = () => {
  const claim = useClaim()
  const { data: incentives } = useIncentives()
  const { data: distribution } = useRanking()

  const { totalRanking, userRanking } = distribution || {}
  const inCentivesAmount = isNaN(Number(incentives?.amount || 0)) ? 0 : incentives?.amount

  return (
    <Card maxW="600px">
      <Text variant="title" fontSize="24px">
        Vesting
      </Text>
      <Chart />

      <HStack w="full" alignSelf="center">
        <Stack w="full" gap="0">
          <Text variant="label" fontSize="xl">
            {num(inCentivesAmount).dp(-6).toString()} MBRN
          </Text>
          <Text fontSize="xs" color="gray">
            Rank: {userRanking} / {totalRanking}
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
