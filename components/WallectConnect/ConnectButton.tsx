import { Button, ButtonProps } from '@chakra-ui/react'
import React from 'react'
import WalletIcon from '../Icons/WalletIcon'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'

type Props = ButtonProps & {
  chain_name?: string
}

const ConnectButton = ({ chain_name = 'osmosis', ...props }: Props) => {
  const { chainName } = useChainRoute()
  const { connect } = useWallet(chainName)

  return (
    <Button leftIcon={<WalletIcon />} onClick={props.onClick ?? connect} {...props}>
      Connect to {chain_name.toUpperCase()}
    </Button>
  )
}

export default ConnectButton
