import { Center, SimpleGrid } from '@chakra-ui/react'
import { BidIcon, ClaimIcon, MintIcon, StakeIcon } from '../Icons'
import FeatureCard from './FeatureCard'
import { StatsCard } from '../StatsCard'

const featurs = [
  {
    label: 'Vaults',
    FeatureIcon: MintIcon,
    href: '/mint',
    ctaLabel: 'Mint',
  },
  {
    label: 'Liquidations',
    FeatureIcon: BidIcon,
    href: '/bid',
    ctaLabel: 'Bid',
  },
  {
    label: 'Staking',
    FeatureIcon: StakeIcon,
    href: '/stake',
    ctaLabel: 'Stake',
  },
  {
    label: 'Lockdrop',
    FeatureIcon: ClaimIcon,
    href: '/lockdrop',
    ctaLabel: 'Claim',
  },
]

const Home = () => {
  return (
    <Center h="full" w="full" justifyContent="center">
      <StatsCard />
      
      <SimpleGrid columns={2} spacing={12} justifyContent="center">
        {featurs.map((feature, index) => (
          <FeatureCard key={index} {...feature} />
        ))}
      </SimpleGrid>
    </Center>
  )
}

export default Home
