import { FC, PropsWithChildren } from 'react'
import { Button, ButtonProps, Tooltip } from '@chakra-ui/react'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from './WallectConnect'

interface ConnectionButtonProps {
  disabledTooltip?: string
}

export const TxButton: FC<PropsWithChildren<ConnectionButtonProps & ButtonProps>> = ({
  disabledTooltip,
  children,
  ...buttonProps
}) => {
  const { isWalletConnected, connect } = useWallet()

  if (!isWalletConnected) {
    return <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps}>{children}</Button>
    </Tooltip>
  )
}
