import { Stack } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'
import { getCookie, setCookie } from '@/helpers/cookies'

import React from "react"

const Home = React.memo(() => {
  var cook = getCookie('test')
  console.log("finsihed cooking", cook)
  return (
    <Stack >
      <StatsCard />
      <QuickActionWidget />
    </Stack>
  )
})

export default Home
