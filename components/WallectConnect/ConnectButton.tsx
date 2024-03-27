import { Button, ButtonProps } from '@chakra-ui/react'
import React from 'react'
import WalletIcon from '../Icons/WalletIcon'
import useWallet from '@/hooks/useWallet'

type Props = ButtonProps & {}

const ConnectButton = (props: Props) => {
  const { connect } = useWallet()

  return (
    <Button leftIcon={<WalletIcon />} onClick={connect} {...props}>
      Connect Wallet
    </Button>
  )
}

export default ConnectButton
