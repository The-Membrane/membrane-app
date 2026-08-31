import React, { useEffect, useRef, useState } from 'react'
import { Button, ButtonProps } from '@chakra-ui/react'

import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

import useDemoMode from '@/hooks/useDemoMode'

export interface DemoAwareCtaProps extends Omit<ButtonProps, 'onClick'> {
  children: React.ReactNode
  /**
   * The real action — e.g. open a confirm sheet. A connected wallet runs
   * this immediately on click. In demo mode the click instead triggers
   * `connect()`, and this same action replays automatically once the
   * wallet connects (see V20 / docs/VETERAN_UX_RULESET.md V20).
   */
  onAction: () => void
  /** Label shown instead of `children` while in demo mode. Defaults to 'Connect wallet'. */
  connectLabel?: string
}

/**
 * Intent-preserving connect CTA (V20, ported from the `window.__exec` wrapper
 * in public/proto/_demo-layer.html). The button never gates the action behind
 * an empty state — in demo mode it becomes the connect button, and clicking
 * it keeps the caller's intent alive so the same confirm sheet reopens for
 * the real signature immediately after connect.
 */
export const DemoAwareCta: React.FC<DemoAwareCtaProps> = ({
  children,
  onAction,
  connectLabel,
  ...buttonProps
}) => {
  const { isDemo, isWalletConnected, connect } = useDemoMode()
  const [intentPending, setIntentPending] = useState(false)

  // Ref so the watcher effect below always replays the latest onAction
  // without needing onAction itself in its dependency array.
  const onActionRef = useRef(onAction)
  onActionRef.current = onAction

  useEffect(() => {
    if (!intentPending || !isWalletConnected) return
    setIntentPending(false)
    onActionRef.current()
  }, [intentPending, isWalletConnected])

  const handleClick = () => {
    if (isDemo) {
      setIntentPending(true)
      connect()
      return
    }
    onAction()
  }

  return (
    <Button
      {...buttonProps}
      borderRadius={0}
      transition={TRANSITIONS.colors}
      _focus={FOCUS_STYLES.ring}
      onClick={handleClick}
    >
      {isDemo ? connectLabel ?? 'Connect wallet' : children}
    </Button>
  )
}

export default DemoAwareCta
