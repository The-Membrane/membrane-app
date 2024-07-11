import { Box, HStack, Stack, Text, Image, IconButton, 
  Modal,
  ModalOverlay,
  ModalContent,
  ModalCloseButton,
  ModalBody,
  VStack} from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { useState } from 'react'
import { BidIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon, NFTAuctionIcon } from './Icons'
import Logo from './Logo'
import WallectConnect from './WallectConnect'
import { BalanceCard } from './BalanceCard'
import { getAssetBySymbol } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'

import { HamburgerIcon } from "@chakra-ui/icons";
import UniversalButtons from './Nav/UniversalButtons'
import useProtocolLiquidations from './Nav/hooks/useLiquidations'
import ConfirmModal from './ConfirmModal'
import { LiqSummary } from './Nav/LiqSummary'

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
  { label: 'Stake', href: '/stake', ItemIcon: StakeIcon },
  { label: 'NFT Auction', href: '/nft', ItemIcon: NFTAuctionIcon },
  { label: 'Lockdrop', href: '/lockdrop', ItemIcon: ClaimIcon },
]

const mobileNavItems: NavItems[] = [
  { label: 'Home', href: '/', ItemIcon: HomeIcon },
  { label: 'Mint', href: '/mint', ItemIcon: MintIcon },
  { label: 'Bid', href: '/bid', ItemIcon: BidIcon },
  { label: 'Stake', href: '/stake', ItemIcon: StakeIcon },
  { label: 'NFT Auction', href: '/nft', ItemIcon: NFTAuctionIcon },
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
      pr={'10px'}
    >
      <ItemIcon color={isActive || isHovered ? 'white' : 'white'} />
      <Text fontSize="lg" fontWeight="400">
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

function SideNav(){
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleMobileMenuToggle = () => {
    setMobileMenuOpen(!isMobileMenuOpen);
  };

  const close = () => {
    setMobileMenuOpen(false);
  };
  const [cdtPrice, setcdtPrice ] = useState(" ")
  const price = getCDTPrice()
  if (price != cdtPrice && price != '0') setcdtPrice(price)
    
  const [enable_msgs, setEnableMsgs] = useState(false)
  const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations()
  
  return (
    <>
    <Stack as="aside" w={[0, 'full']} maxW="256px" minW="200px" p="6" bg="whiteAlpha.100" style={{zoom: '85%'}} display={{ base: "none", md: "flex" }}>
      <Stack as="ul" gap="1">
        <Stack marginTop={"6%"}>
          <Logo />
          <HStack justifyContent={"center"}>
            <Image src={"/images/cdt.svg"} w="18px" h="18px" />
            <Text variant="title" letterSpacing="unset" textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize={"medium"}>
              {cdtPrice != " " && cdtPrice != "0" ? "$" : null}{cdtPrice}
            </Text>
          </HStack>
        </Stack>
        <Box h="10" />
        {navItems.map((item, index) => (
          <NavItem key={index} {...item} />
        ))}
        <WallectConnect />
      </Stack>
        <Text cursor="pointer" fontSize="14px" textDecoration={"underline"} onClick={() => setEnableMsgs(true)} justifyContent={"center"} display={enable_msgs ? "none" : "flex"}>
        Check For Claims
        </Text>
        {enable_msgs ? <UniversalButtons /> : null}
        <Stack>          
            {/* Liquidate Button */}
            <ConfirmModal
            label={ 'Liquidate' }
            action={liquidate}
            isDisabled={liq_summ.length === 0}
            >
            <LiqSummary liquidations={liq_summ}/>
            </ConfirmModal>  
        </Stack>

      <BalanceCard />
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
        {mobileNavItems.map((item, index) => (
          <NavItem key={index} {...item} />
        ))}
          <WallectConnect />
        </VStack>
      </ModalBody>
    </ModalContent>
  </Modal>
  </>
  )
}

export default SideNav