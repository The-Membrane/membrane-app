import { Button, ButtonProps } from '@chakra-ui/react'
import React from 'react'
import WalletIcon from '../Icons/WalletIcon'
import { useConnectModal } from '@rainbow-me/rainbowkit'

type Props = ButtonProps

/**
 * Disconnected-state connect button. Keeps the app's styled Chakra button but opens
 * RainbowKit's wallet-picker modal (MetaMask / injected / WalletConnect / Coinbase)
 * instead of the old direct-connect that silently failed with no injected wallet.
 * An explicit `onClick` still wins, so callers can override the behavior.
 */
const ConnectButton = (props: Props) => {
  const { openConnectModal } = useConnectModal()

  return (
    <Button
      leftIcon={<WalletIcon />}
      onClick={props.onClick ?? openConnectModal}
      minH="44px"
      w="48vw"
      maxW="144px"
      {...props}
    >
      Connect
    </Button>
  )
}

export default ConnectButton
