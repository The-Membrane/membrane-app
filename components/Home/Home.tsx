import { Stack } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import QuickActionWidget from './QuickActionWidget'

const Home = () => {

  return (
    <Stack >
      <StatsCard />
      <QuickActionWidget actionMenuOptions={[{value: "LP", label: "LP"}, {value: "Bid", label: "Bid"}, {value: "Loop", label: "Loop"}]}/>
    </Stack>
  )
}

export default Home
