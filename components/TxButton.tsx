import { FC, PropsWithChildren } from 'react'
import { Button, ButtonProps, Tooltip } from '@chakra-ui/react'
import useWallet from '@/hooks/useWallet'

interface ConnectionButtonProps {
  disabledTooltip?: string
  chain_name?: string
}

export const TxButton: FC<PropsWithChildren<ConnectionButtonProps & ButtonProps>> = ({
  disabledTooltip,
  chain_name = 'osmosis',
  children,
  ...buttonProps
}) => {
  const { isWalletConnected, connect } = useWallet(chain_name)

  if (!isWalletConnected) {
    return <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps}>{children}</Button>
    </Tooltip>
  )
}
