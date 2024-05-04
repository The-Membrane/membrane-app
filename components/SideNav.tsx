import { Box, Button, HStack, Stack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { useState } from 'react'
import { BidIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon } from './Icons'
import Logo from './Logo'
import WallectConnect from './WallectConnect'
import { BalanceCard } from './BalanceCard'
import useProtocolClaims from './Nav/hooks/useClaims'
import ConfirmModal from './ConfirmModal'
import { ClaimSummary } from './Bid/ClaimSummary'
import { num } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import useProtocolLiquidations from './Nav/hooks/useLiquidations'
import { LiqSummary } from './Nav/LiqSummary'
import { CommunityPoolSpendProposal } from 'cosmjs-types/cosmos/distribution/v1beta1/distribution'

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
  const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations()
  console.log(liq_summ)

  //Disable claims for a time period to allow simulates to run
  const [enable_msgs, setEnableMsgs] = useState(false)
  setTimeout(() => setEnableMsgs(true), 2222);

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
        isDisabled={claim?.simulate.isError || !claim?.simulate.data || !enable_msgs || claims_summary.length === 0}
      >
        <ClaimSummary claims={claims_summary}/>
      </ConfirmModal>
      {/* Liquidate Button */}
      <ConfirmModal
        label={ 'Liquidate' }
        action={liquidate}
        isDisabled={liquidate?.simulate.isError || !liquidate?.simulate.data || !enable_msgs || liq_summ.length === 0}
      >
        <LiqSummary liquidations={liq_summ}/>
      </ConfirmModal>

      <BalanceCard />
    </Stack>
  )
}

export default SideNav