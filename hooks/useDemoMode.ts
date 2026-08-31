import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'

import useWallet from '@/hooks/useWallet'
import { truncate } from '@/helpers/truncate'

/**
 * Demo-first state machine (V20 / docs/VETERAN_UX_RULESET.md V20, ported from
 * public/proto/_demo-layer.html's localStorage 'membrane.wallet' seam).
 *
 * A page is "in demo" whenever there is no connected wallet, OR the URL forces
 * it via `?demo` query or `#demo` hash (useful for screenshots/QA/sales demos
 * without a wallet). Wallet-scoped blocks render the fixed demo wallet under
 * DemoBanner; protocol-scoped blocks stay live regardless of isDemo.
 */

/** Fixed demo wallet shown wherever a truncated address is displayed in demo mode. */
export const DEMO_ADDRESS = '0x9a41…c2e0'

/** Full (untruncated) demo wallet address — for anywhere the raw value is needed. */
export const DEMO_ADDRESS_FULL = '0x9a41000000000000000000000000000000c2e0'

export interface UseDemoModeResult {
  /** True whenever wallet-scoped UI should render demo fixtures instead of live wallet data. */
  isDemo: boolean
  /** True when the URL explicitly forced demo mode via `?demo` or `#demo`, independent of wallet state. */
  isForcedDemo: boolean
  isWalletConnected: boolean
  isConnecting: boolean
  address: ReturnType<typeof useWallet>['address']
  /** Truncated address for display: the demo wallet while isDemo, else the real truncated address. */
  displayAddress: string
  connect: () => void
}

const useDemoMode = (): UseDemoModeResult => {
  const router = useRouter()
  const { address, isWalletConnected, isConnecting, connect } = useWallet()

  // SSR-safe: both `?demo` (router.query is not reliably populated on the
  // server/first paint) and `#demo` (the hash never reaches the server at
  // all) are resolved together in an effect, defaulting to false so the
  // server render and the first client render always agree.
  const [isForcedDemo, setIsForcedDemo] = useState(false)

  useEffect(() => {
    const hasQueryDemo = router.query.demo !== undefined
    const hasHashDemo = window.location.hash === '#demo'
    setIsForcedDemo(hasQueryDemo || hasHashDemo)
  }, [router.query])

  const isDemo = isForcedDemo || !isWalletConnected

  const displayAddress = isDemo ? DEMO_ADDRESS : truncate(address) ?? DEMO_ADDRESS

  return {
    isDemo,
    isForcedDemo,
    isWalletConnected,
    isConnecting,
    address,
    displayAddress,
    connect,
  }
}

export default useDemoMode
