import React from 'react'
import { Card, Heading, Link, Stack, Text } from '@chakra-ui/react'

const Info = () => {
  return (
    <Card gap="5">
      <Text variant="title" fontSize="24px">
        Lockdrop
      </Text>

      <Stack>
        <Heading fontSize="xl" fontWeight="bold">
          Info
        </Heading>
        <Text fontSize="sm" color="gray.400">
          There is 10M MBRN up for grabs in this 7 day event. Deposit * Lock Time = Shares (Lock
          MAX: 365 DAYS). Locks boost your “shares” and the full 10M is split & STAKED (4 day
          unstaking) in accordance to the ratio of said shares. MBRN claims unlock daily.
          <Link
            fontSize="sm"
            color="primary.200"
            isExternal
            ml="1"
            href="https://membrane-finance.gitbook.io/membrane-docs-1/protocol/lockdrop-launch"
          >
            more info
          </Link>
        </Text>
      </Stack>

      <Stack>
        <Heading fontSize="xl" fontWeight="bold">
          Allocations
        </Heading>
        <Text fontSize="sm" color="gray.400">
          Pre-launch contributors: 9%, vested for 2y cliff/1y linear --- Community: 91% Stakers have
          control over vested stake.
          <Link
            fontSize="sm"
            color="primary.200"
            isExternal
            ml="1"
            href="https://membrane-finance.gitbook.io/membrane-docs-1/protocol/mbrn-tokenomics"
          >
            more info
          </Link>
        </Text>
      </Stack>
    </Card>
  )
}

export default Info
