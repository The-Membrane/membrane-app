import { num } from '@/helpers/num'
import { Box, Grid, Stack, Text } from '@chakra-ui/react'
import { DebtRowData } from './types'

// Format time remaining until fixed rate expiry
const formatTimeRemaining = (endTime: number): string => {
  const now = Math.floor(Date.now() / 1000)
  const remaining = endTime - now
  if (remaining <= 0) return 'Expired'

  const days = Math.floor(remaining / (60 * 60 * 24))
  if (days > 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays > 0 ? `${months}mo ${remainingDays}d` : `${months}mo`
  }
  return `${days}d`
}

interface DebtCardSegmentsProps {
  segments: DebtRowData[]
  totalAmount: number
}

export const DebtCardSegments = ({ segments, totalAmount }: DebtCardSegmentsProps) => {
  return (
    <Box
      p={3}
      bg="rgba(0, 0, 0, 0.3)"
      borderLeft="2px solid"
      borderColor="cyan.500"
      mx={2}
      mb={1}
    >
      {/* Segment header */}
      <Grid templateColumns="1fr 1fr 1fr 1fr" gap={2} mb={1}>
        <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase">
          Type
        </Text>
        <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
          Rate
        </Text>
        <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
          Amount
        </Text>
        <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
          Expires
        </Text>
      </Grid>

      {/* Segment rows */}
      {segments.map((segment) => (
        <Grid templateColumns="1fr 1fr 1fr 1fr" gap={2} key={segment.type} py={1}>
          <Text color="whiteAlpha.800" fontSize="xs" fontWeight="medium">
            {segment.type}
          </Text>
          <Text
            color={segment.rate > 0 ? 'red.300' : 'whiteAlpha.800'}
            fontSize="xs"
            textAlign="right"
          >
            {segment.rate > 0 ? `${segment.rate.toFixed(2)}%` : '-'}
          </Text>
          <Stack spacing={0} alignItems="flex-end">
            <Text color="whiteAlpha.800" fontSize="xs">
              ${num(segment.amount).toFixed(2)}
            </Text>
            {totalAmount > 0 && (
              <Text color="whiteAlpha.500" fontSize="2xs">
                {num(segment.amount).dividedBy(totalAmount).times(100).toFixed(1)}%
              </Text>
            )}
          </Stack>
          <Box textAlign="right">
            {segment.endTime ? (
              <Stack spacing={0} alignItems="flex-end">
                <Text color="whiteAlpha.700" fontSize="xs" suppressHydrationWarning>
                  {formatTimeRemaining(segment.endTime)}
                </Text>
                <Text color="whiteAlpha.500" fontSize="2xs">
                  {segment.rollover ? 'rollover' : 'to variable'}
                </Text>
              </Stack>
            ) : (
              <Text color="whiteAlpha.500" fontSize="xs">-</Text>
            )}
          </Box>
        </Grid>
      ))}
    </Box>
  )
}
