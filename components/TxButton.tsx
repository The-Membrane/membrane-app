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

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/2832749a-788e-42b9-9c1d-ba475ed16f2f', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'TxButton.tsx:27', message: 'TxButton render', data: { chainName, chain_name_prop: chain_name, displayChainName, formattedChainName, isWalletConnected }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'post-fix', hypothesisId: 'A' }) }).catch(() => { });
  // #endregion

  if (!isWalletConnected) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2832749a-788e-42b9-9c1d-ba475ed16f2f', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'TxButton.tsx:34', message: 'Rendering connect button', data: { chain_name_display: formattedChainName, chainName_from_route: chainName, toggleConnectLabel }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'post-fix', hypothesisId: 'A' }) }).catch(() => { });
    // #endregion
    return toggleConnectLabel ? <Button {...buttonProps} isDisabled={false} onClick={connect}>Connect to {formattedChainName}</Button>
      : <Button {...buttonProps} isDisabled={false} onClick={connect}>{children}</Button>
  }

  return (
    <Tooltip hasArrow label={buttonProps.isDisabled ? disabledTooltip : ''}>
      <Button {...buttonProps} fontSize={fontSize}>{children}</Button>
    </Tooltip>
  )
}
