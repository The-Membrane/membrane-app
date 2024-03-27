import LockedAccess from '@/components/LockedAccess'
import Mint from '@/components/Mint'
import useWallet from '@/hooks/useWallet'

const MintPage = () => {
  const { isWalletConnected } = useWallet()

  if (!isWalletConnected) return <LockedAccess />

  return <Mint />
}

export default MintPage
