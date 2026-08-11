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
  chain_name,
  toggleConnectLabel = true,
  children,
  fontSize = 'md',
  ...buttonProps
}) => {
  const { chainName } = useChainRoute()
  const { isWalletConnected, connect } = useWallet(chainName)

  // Use chainName from route as default, but allow chain_name prop to override
  const displayChainName = chain_name || chainName
  // Capitalize first letter
  const formattedChainName = displayChainName.charAt(0).toUpperCase() + displayChainName.slice(1).toLowerCase()

  if (!isWalletConnected) {
    return toggleConnectLabel ? <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect to {formattedChainName}</Button>
      : <Button {...buttonProps} isDisabled={false} onClick={connect}>{children}</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps} fontSize={fontSize}>{children}</Button>
    </Tooltip>
  )
}
