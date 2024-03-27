import { Box, Card, HStack, Stack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { useState } from 'react'
import { BidIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon } from './Icons'
import Logo from './Logo'
import WallectConnect from './WallectConnect'

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
  { label: 'Governance', href: '/governance', ItemIcon: StakeIcon },
]

const NavItem = ({ label, href, ItemIcon }: NavItems) => {
  const router = useRouter()
  const isActive = router.asPath === href
  const [isHovered, setIsHovered] = useState(false)

  const hoverStyles = {
    borderRadius: '8px',
    border: '1px solid #C445F0',
    background: '#290A34',
    boxShadow: '0px 0px 16px 0px rgba(196, 69, 240, 0.32)',
    color: '#C445F0',
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
      <ItemIcon color={isActive || isHovered ? '#C445F0' : 'white'} />
      <Text fontSize="lg" fontWeight="400">
        {label}
      </Text>
    </HStack>
  )
}

const SideNav = () => {
  return (
    <Card w="300px" minW="240px" h="90vh" position="fixed">
      <Stack as="ul" gap="2">
        <Logo />
        <Box h="10" />
        {navItems.map((item, index) => (
          <NavItem key={index} {...item} />
        ))}
        <WallectConnect />
      </Stack>
    </Card>
  )
}

export default SideNav
