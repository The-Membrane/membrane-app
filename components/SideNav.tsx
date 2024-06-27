import { Box, HStack, Stack, Text, Image, IconButton, 
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  VStack,
  Link as ChakraLink,
  Button, 
  Flex} from '@chakra-ui/react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import React, { useState } from 'react'
import { BidIcon, ClaimIcon, HomeIcon, MintIcon, StakeIcon, NFTAuctionIcon } from './Icons'
import Logo from './Logo'
import WallectConnect from './WallectConnect'
import { BalanceCard } from './BalanceCard'
import useProtocolClaims from './Nav/hooks/useClaims'
import ConfirmModal from './ConfirmModal'
import { ClaimSummary } from './Bid/ClaimSummary'
import useProtocolLiquidations from './Nav/hooks/useLiquidations'
import { LiqSummary } from './Nav/LiqSummary'
import { getAssetBySymbol } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'

import { HamburgerIcon } from "@chakra-ui/icons";

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

  const { action: claim, claims_summary } = useProtocolClaims()
  const { action: liquidate, liquidating_positions: liq_summ } = useProtocolLiquidations()

  //Disable claims for a time period to allow simulates to run
  const [enable_msgs, setEnableMsgs] = useState(false)
  setTimeout(() => setEnableMsgs(true), 2222);
  
  return (
    <Flex
      px={4}
      py={2}
      bg="rgba(0, 0, 0, 0.15)"
      color="white"
      width="100vw"
      zIndex={1}
      justifyContent="center"
    >
      <Flex
        h={16}
        alignItems={"center"}
        justifyContent={"space-between"}
        width="100vw"
        maxW="7xl"
      >
    <Stack as="aside" w={[0, 'full']} maxW="256px" minW="200px" h="100%" p="6" bg="whiteAlpha.100" style={{zoom: '85%'}} display={{ base: "none", md: "flex" }}>
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
  </Flex>

  {/* Mobile Menu Modal */}
  <Modal isOpen={isMobileMenuOpen} onClose={close}>
    <ModalOverlay bg="rgba(0, 0, 0, 0.7)" />
    <ModalContent bg="transparent" color="white" mt={4}>
      <ModalCloseButton mr={2} />
      <ModalBody mt={8}>
        <VStack spacing={8} mt={12}>
          <ChakraLink fontWeight="medium" href="#home" onClick={close}>
            Home
          </ChakraLink>
          <ChakraLink fontWeight="medium" href="#protocol" onClick={close}>
            Protocol Overview
          </ChakraLink>
          <ChakraLink
            fontWeight="medium"
            href="#governance"
            onClick={close}
          >
            Governance
          </ChakraLink>
          <ChakraLink fontWeight="medium" href="#vision" onClick={close}>
            The Vision
          </ChakraLink>
          <ChakraLink fontWeight="medium" href="#faqs" onClick={close}>
            FAQs
          </ChakraLink>
        </VStack>
      </ModalBody>
    </ModalContent>
  </Modal>
 </Flex>
  )
}

export default SideNav