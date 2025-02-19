import LockedAccess from '@/components/Mint/LockedAccess'
import Mint from '@/components/Mint'
import useWallet from '@/hooks/useWallet'
import Beaker from '@/components/Mint/Beaker'
import { HStack } from '@chakra-ui/react'

const MintPage = () => {
  const { isWalletConnected } = useWallet()

  if (!isWalletConnected) return (
    <HStack justifyContent={"center"} mt="10%">
      <LockedAccess />
      {/* <Beaker /> */}
      {/* <BeakerScale /> */}
    </HStack>)

  return <Mint />
}

export default MintPage
