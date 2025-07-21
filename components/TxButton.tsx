import { FC, PropsWithChildren } from 'react'
import { Button, ButtonProps, Tooltip } from '@chakra-ui/react'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'

interface ConnectionButtonProps {
  disabledTooltip?: string
  chain_name?: string
  toggleConnectLabel?: boolean
  fontSize?: string
}

export const TxButton: FC<PropsWithChildren<ConnectionButtonProps & ButtonProps>> = ({
  disabledTooltip,
  chain_name = 'osmosis',
  toggleConnectLabel = true,
  children, 
  fontSize = 'md',
  ...buttonProps
}) => {
  const { chainName } = useChainRoute()
  const { isWalletConnected, connect } = useWallet(chainName)

  if (!isWalletConnected) {
    return toggleConnectLabel ? <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect to {chain_name.toUpperCase()}</Button>
      : <Button {...buttonProps} isDisabled={false} onClick={connect}>{children}</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps} fontSize={fontSize}>{children}</Button>
    </Tooltip>
  )
}
