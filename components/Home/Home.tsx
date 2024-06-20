import { Stack } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'
import { setCookie } from '@/helpers/cookies'

import React from "react"

const Home = React.memo(() => {
  setCookie('test', 'big booty judy', 1)
  return (
    <Stack >
      <StatsCard />
      <QuickActionWidget />
    </Stack>
  )
})

export default Home
