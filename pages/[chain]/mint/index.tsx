import LockedAccess from '@/components/Mint/LockedAccess'
import Mint from '@/components/Mint'
import { NeutronMint } from '@/components/NeutronMint'
import PageSeo from '@/components/PageSeo'
import useWallet from '@/hooks/useWallet'
import Beaker from '@/components/Mint/Beaker'
import { HStack } from '@chakra-ui/react'
import { useChainRoute } from '@/hooks/useChainRoute'
import { DEFAULT_CHAIN } from '@/config/chains'

const MintPage = () => {
  const { chainName } = useChainRoute()
  // const { isWalletConnected } = useWallet()

  // if (!isWalletConnected) return (
  //   <HStack justifyContent={"center"} mt="10%">
  //     <LockedAccess />
  //     {/* <Beaker /> */}
  //     {/* <BeakerScale /> */}
  //   </HStack>)

  // EVM-only single chain: NeutronMint is the current mint experience
  return (
    <>
      {/* Rule 0 (docs/SEO_RULESET.md): indexable — marketing entry page for minting CDT */}
      <PageSeo
        seoClass="indexable"
        title="Membrane — Borrow CDT Against Your Crypto (Mint)"
        description="Open a collateralized debt position: post crypto collateral, mint the CDT stablecoin, and manage your LTV with a 4% liquidation window and an 8-hour cure timer."
        path={`/${DEFAULT_CHAIN}/mint`}
      />
      <NeutronMint />
    </>
  )
}

export default MintPage
