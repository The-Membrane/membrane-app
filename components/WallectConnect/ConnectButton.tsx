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
 *
 * The label is centred and the wallet glyph takes the label's colour (it was hard white,
 * so on the Parchment theme it drew nothing and pushed the word off centre). The
 * `data-connect-button` hook lets a page layer restyle every instance at once: on the
 * news edition it is a raised print button (styles/news-edition.css).
 */
const ConnectButton = (props: Props) => {
  const { openConnectModal } = useConnectModal()

  return (
    <Button
      data-connect-button=""
      leftIcon={<WalletIcon color="currentColor" />}
      justifyContent="center"
      textAlign="center"
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
