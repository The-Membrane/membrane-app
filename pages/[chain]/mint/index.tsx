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

  // EVM-only single chain: NeutronMint is the current mint experience
  return <NeutronMint />
}

export default MintPage
