import { Stack } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'

const Home = () => {

  return (
    <Stack >
      <StatsCard />
      <QuickActionWidget />
    </Stack>
  )
}

export default Home
