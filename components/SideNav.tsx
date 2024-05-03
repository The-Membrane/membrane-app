import { Box, Button, HStack, Stack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { useState } from 'react'
import { BidIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon } from './Icons'
import Logo from './Logo'
import { StatsCard } from './StatsCard'
import WallectConnect from './WallectConnect'
import { BalanceCard } from './BalanceCard'
import useProtocolClaims from './Nav/hooks/useClaims'
import ConfirmModal from './ConfirmModal'
import { getRiskyPositions } from '@/services/cdp'
import { useBasketPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { ClaimSummary } from './Bid/ClaimSummary'
import { coin } from 'cosmwasm'
import { num } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'

type NavItems = {
  label: string
  href: string
  ItemIcon: React.FC<{
    color?: string
  }>
}

const navItems: NavItems[] = [
  { label: 'Home', href: '/', ItemIcon: HomeIcon },
  { label: 'Mint', href: '/mint', ItemIcon: MintIcon },
  { label: 'Bid', href: '/bid', ItemIcon: BidIcon },
  { label: 'Lockdrop', href: '/lockdrop', ItemIcon: ClaimIcon },
  { label: 'Stake', href: '/stake', ItemIcon: StakeIcon },
]

const NavItem = ({ label, href, ItemIcon }: NavItems) => {
  const router = useRouter()
  const isActive = router.asPath === href
  const [isHovered, setIsHovered] = useState(false)

  const hoverStyles = {
    borderRadius: '8px',
    bg: 'primary.200',
  }

  return (
    <HStack
      as={NextLink}
      href={href}
      cursor="pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      _hover={hoverStyles}
      {...(isActive && hoverStyles)}
      p={label === 'Home' ? '5px' : '0'}
    >
      <ItemIcon color={isActive || isHovered ? 'white' : 'white'} />
      <Text fontSize="lg" fontWeight="400">
        {label}
      </Text>
    </HStack>
  )
}

const SideNav = () => {
  const { action: claim, claims_summary } = useProtocolClaims()
  //Transform claim summary to a single list of Coin
  const claims = Object.values(claims_summary).reduce((acc, val) => acc.concat(val), [])
  //Aggregate coins in claims that have the same denom
  const agg_claims = claims.filter((coin) => num(coin.amount).isGreaterThan(0))
  .reduce((acc, claim) => {
    const existing = acc.find((c) => c.denom === claim.denom)
    if (existing) {
      //Remove claim from acc
      acc = acc.filter((c) => c.denom !== claim.denom)
      //Add new
      acc.push({
        denom: claim.denom,
        amount: num(claim.amount).plus(existing.amount).toString(),
      })
    } else {
      acc.push(claim)
    }
    return acc
  }, [] as Coin[])

  //Move this to on-click of the button only
  //It'll be within a larger use function that creates the liq msgs as well
  // const { data: allPositions } = useBasketPositions()
  // const { data: prices } = useOraclePrice()
  // const liq = getRiskyPositions(allPositions, prices).filter((pos) => pos !== undefined)

  console.log(claims_summary)
  return (
    <Stack as="aside" w={[0, 'full']} maxW="256px" minW="200px" h="100%" p="6" bg="whiteAlpha.100" style={{zoom: '90%'}}>
      <Stack as="ul" gap="2">
        <Logo />
        <Box h="10" />
        {navItems.map((item, index) => (
          <NavItem key={index} {...item} />
        ))}
        <WallectConnect />
      </Stack>
      {/* Claim Button */}
      <ConfirmModal
        label={ 'Claim' }
        action={claim}
        isDisabled={claims_summary.liquidation.length === 0 && claims_summary.sp_unstaking.length === 0 && claims_summary.staking.length === 0 && claims_summary.vesting.length === 0}
        // isDisabled={claim?.simulate.isError || !claim?.simulate.data}
      >
        <ClaimSummary claims={agg_claims}/>
      </ConfirmModal>

      <BalanceCard />
    </Stack>
  )
}

export default SideNav