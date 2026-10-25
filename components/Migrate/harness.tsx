import React, { createContext, useContext } from 'react'
import type { PublicClient, WalletClient } from 'viem'

import type { Address } from '@/lib/migrate/types'

/**
 * DEV / TEST HARNESS ONLY. Lets pages/dev/migrate-sheet run the real sheet against a local anvil
 * with an anvil test key instead of an injected wallet (a headless browser has none). Production
 * never renders this provider; without it the sheet uses wagmi (useWallet) and the demo state.
 */
export interface MigrateEnv {
  isDemo: boolean
  chainId: number | undefined
  chainLabel: string
  address: Address | undefined
  publicClient: PublicClient | undefined
  walletClient: WalletClient | undefined
  connect: () => void
  isWalletConnected: boolean
  /** Dev harness: hold at the read rows instead of simulating (the "ready plan" state). */
  holdBeforeSimulate?: boolean
  /** Dev harness: press the primary button as soon as the simulation passes. */
  autoStart?: boolean
  /** Dev harness: press the optional revoke once settled. */
  autoRevoke?: boolean
}

const HarnessContext = createContext<MigrateEnv | null>(null)

export const MigrateHarness: React.FC<{ env: MigrateEnv; children: React.ReactNode }> = ({ env, children }) => (
  <HarnessContext.Provider value={env}>{children}</HarnessContext.Provider>
)

export const useMigrateHarness = (): MigrateEnv | null => useContext(HarnessContext)
