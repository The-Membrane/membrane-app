import LockedAccess from '@/components/LockedAccess'
import Mint from '@/components/Mint'
import useWallet from '@/hooks/useWallet'
import Beaker from '@/components/Mint/Beaker'
import { HStack } from '@chakra-ui/react'

const MintPage = () => {
  const { isWalletConnected } = useWallet()

  if (!isWalletConnected) return (
  <HStack alignItems="flex-start">
    <LockedAccess />
    {/* <Beaker /> */}
    {/* <BeakerScale /> */}
  </HStack>)

  return <Mint />
}

export default MintPage
