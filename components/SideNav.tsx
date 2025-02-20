import {
  Box, HStack, Stack, Text, Image, IconButton,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalCloseButton,
  ModalBody,
  VStack,
  Button
} from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { BidIcon, EarnIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon, NFTAuctionIcon, DashboardIcon } from './Icons'
import Logo from './Logo'
import WallectConnect from './WallectConnect'
import { BalanceCard } from './BalanceCard'
import { getAssetBySymbol } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'

import { HamburgerIcon } from "@chakra-ui/icons";
import UniversalButtons from './Nav/UniversalButtons'
import SoloLeveling from './Nav/PointsLevel'
import { colors } from '@/config/defaults'

type NavItems = {
  label: string
  href: string
  ItemIcon: React.FC<{
    color?: string
  }>
}

const navItems: NavItems[] = [
  { label: 'Upper Management', href: '/management', ItemIcon: DashboardIcon },
  { label: 'Home', href: '/', ItemIcon: HomeIcon },
  { label: 'Manic', href: '/manic', ItemIcon: EarnIcon },
  { label: 'Borrow', href: '/mint', ItemIcon: MintIcon },
  { label: 'Bid', href: '/bid', ItemIcon: BidIcon },
  { label: 'Stake', href: '/stake', ItemIcon: StakeIcon },
  // { label: 'NFT Auction', href: '/nft', ItemIcon: NFTAuctionIcon },
  // { label: 'Lockdrop', href: '/lockdrop', ItemIcon: ClaimIcon },
]

const mobileNavItems: NavItems[] = [
  { label: 'Upper Management', href: '/management', ItemIcon: DashboardIcon },
  { label: 'Home', href: '/', ItemIcon: HomeIcon },
  { label: 'Manic', href: '/manic', ItemIcon: EarnIcon },
  { label: 'Borrow', href: '/mint', ItemIcon: MintIcon },
  { label: 'Bid', href: '/bid', ItemIcon: BidIcon },
  { label: 'Stake', href: '/stake', ItemIcon: StakeIcon },
  // { label: 'NFT Auction', href: '/nft', ItemIcon: NFTAuctionIcon },
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
      justifyContent={label === 'Upper Management' ? "center" : "none"}
      {...(isActive && hoverStyles)}
      p={label === 'Home' ? '5px' : '0'}
      pr={label === 'Upper Management' ? '0' : '10px'}
      pt={label === 'Upper Management' ? '10px' : label === 'Home' ? "5px" : '0'}
      pb={label === 'Upper Management' ? '10px' : label === 'Home' ? "5px" : '0'}
    >
      <ItemIcon color={isActive || isHovered ? 'white' : 'white'} />
      <Text fontSize="lg" fontWeight="400" >
        {label}
      </Text>
    </HStack>
  )
}

const getCDTPrice = () => {
  const cdt = getAssetBySymbol('CDT')
  const { data: prices } = useOraclePrice()
  const price = prices?.find((price) => price.denom === cdt?.base)
  if (!price) return '0'
  return parseFloat((price.price)).toFixed(4)
}

// Memoize static components
const MemoizedLogo = memo(Logo);
const MemoizedBalanceCard = memo(BalanceCard);
// const MemoizedUniversalButtons = memo(UniversalButtons);
const MemoizedSoloLeveling = memo(SoloLeveling);
const MemoizedNavItem = memo(NavItem);

function SideNav() {
  console.log("render heavy")
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [cdtPrice, setcdtPrice] = useState(" ");
  const [enable_msgs, setEnableMsgs] = useState(false);

  // useEffect(() => {
  const price = getCDTPrice();
  if (price !== cdtPrice && price !== '0') {
    setcdtPrice(price);
  }
  // }, [cdtPrice]);

  // Memoize handlers
  const handleMobileMenuToggle = useCallback(() => {
    setMobileMenuOpen(prev => !prev);
  }, []);

  const close = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  const handleEnableMsgs = useCallback(() => {
    setEnableMsgs(true);
  }, []);

  // Memoize static nav items
  const memoizedNavItems = useMemo(() =>
    navItems.map((item, index) => (
      <MemoizedNavItem key={index} {...item} />
    ))
    , []);

  // Memoize static mobile nav items
  const memoizedMobileNavItems = useMemo(() =>
    mobileNavItems.map((item, index) => (
      <MemoizedNavItem key={index} {...item} />
    ))
    , []);

  // Memoize price display
  const priceDisplay = useMemo(() => (
    <HStack justifyContent={"center"}>
      <Image src={"/images/cdt.svg"} w="18px" h="18px" />
      <Text variant="title" letterSpacing="unset" textShadow={`0px 0px 8px ${colors.tabBG}`} fontSize={"medium"}>
        {cdtPrice != " " && cdtPrice != "0" ? "$" : null}{cdtPrice}
      </Text>
    </HStack>
  ), [cdtPrice]);

  return (
    <>
      <Stack as="aside" w={[0, 'full']} maxW="256px" minW="200px" p="6" gap="1rem" bg="whiteAlpha.100" height="fit-content" display={{ base: "none", md: "flex" }}>
        <Stack as="ul" gap="7">
          <Stack marginTop={"6%"}>
            <MemoizedLogo />
            {priceDisplay}
          </Stack>
          <MemoizedSoloLeveling />
          <Box h="3" />
          {memoizedNavItems}
          <WallectConnect />
        </Stack>

        <Button
          textAlign="center"
          whiteSpace={"prewrap"}
          fontSize="14px"
          onClick={handleEnableMsgs}
          justifyContent={"center"}
          display={enable_msgs ? "none" : "flex"}
        >
          Check For Claims & Liquidations
        </Button>

        <div style={{ display: enable_msgs ? "block" : "none" }}>
          <UniversalButtons enabled={enable_msgs} />
        </div>
        <MemoizedBalanceCard />
      </Stack>

      {/* Mobile Menu */}
      <HStack as="mobile" display={{ base: "flex", md: "none" }} spacing="0.5rem">
        {!isMobileMenuOpen && (
          <IconButton
            icon={<HamburgerIcon />}
            aria-label={"Open Menu"}
            bg="transparent"
            color="white"
            onClick={handleMobileMenuToggle}
          />
        )}
      </HStack>

      {/* Mobile Menu Modal */}
      <Modal isOpen={isMobileMenuOpen} onClose={close}>
        <ModalOverlay bg="rgba(0, 0, 0, 0.7)" />
        <ModalContent bg="transparent" color="white" mt={4}>
          <ModalCloseButton mr={2} />
          <ModalBody mt={8}>
            <VStack spacing={8} mt={12} onClick={close}>
              {memoizedMobileNavItems}
              <WallectConnect />
            </VStack>
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}

// Memoize the entire SideNav if its parent might cause unnecessary rerenders
export default memo(SideNav);