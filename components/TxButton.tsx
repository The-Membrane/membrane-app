import { FC, PropsWithChildren } from 'react'
import { Button, ButtonProps, Tooltip } from '@chakra-ui/react'
import useWallet from '@/hooks/useWallet'

interface ConnectionButtonProps {
  disabledTooltip?: string
  chain_name?: string
  toggleConnectLabel?: boolean
}

export const TxButton: FC<PropsWithChildren<ConnectionButtonProps & ButtonProps>> = ({
  disabledTooltip,
  chain_name = 'osmosis',
  toggleConnectLabel = true,
  children,
  ...buttonProps
}) => {
  const { isWalletConnected, connect } = useWallet(chain_name)

  if (!isWalletConnected) {
    return toggleConnectLabel ? <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect to {chain_name.toUpperCase()}</Button>
      : <Button {...buttonProps} isDisabled={false} onClick={connect}>{children}</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps}>{children}</Button>
    </Tooltip>
  )
}
