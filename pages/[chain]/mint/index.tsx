import LockedAccess from '@/components/Mint/LockedAccess'
import Mint from '@/components/Mint'
import { NeutronMint } from '@/components/NeutronMint'
import useWallet from '@/hooks/useWallet'
import Beaker from '@/components/Mint/Beaker'
import { HStack } from '@chakra-ui/react'
import { useChainRoute } from '@/hooks/useChainRoute'

const MintPage = () => {
  const { chainName } = useChainRoute()
  // const { isWalletConnected } = useWallet()

  // if (!isWalletConnected) return (
  //   <HStack justifyContent={"center"} mt="10%">
  //     <LockedAccess />
  //     {/* <Beaker /> */}
  //     {/* <BeakerScale /> */}
  //   </HStack>)

  // Use NeutronMint for Neutron chains, regular Mint for others
  const isNeutronChain = chainName === 'neutron' || chainName === 'neutrontestnet'

  if (isNeutronChain) {
    return <NeutronMint />
  }

  return <Mint />
}

export default MintPage
