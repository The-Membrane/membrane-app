import React, { useMemo } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import { useRouter } from 'next/router'
import { Box, Text, VStack } from '@chakra-ui/react'
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { anvil } from '@/config/evm/chains'

import { DeploySheet, MigrateSheet } from '@/components/Migrate'
import { MigrateHarness, type MigrateEnv } from '@/components/Migrate/harness'

import { demoBorrowerPosition } from '@/lib/position-sim/demoBorrower'
import { sendBatch7702 } from '@/lib/migrate/sendBatch7702'
import local from '@/contracts/migrator/deployments/local.json'

/**
 * DEV ONLY (404 in production). Renders the real migrate / deploy sheets in each state for the
 * Q41 screenshot track. Nothing here is a fixture number:
 *   - the rows come from the demo borrower (a real Aave V3 wallet, lib/position-sim/demoBorrower)
 *     or from a read of the local anvil stack (contracts/migrator/local-anvil.sh);
 *   - wallet states use public anvil test keys through MigrateHarness, because a headless
 *     browser has no injected wallet.
 *
 * ?state= demo | wrong-chain | mainnet | ready | trim | simulated | settled | batch | batch-settled   &sheet=deploy
 *   batch*: the wallet reports atomic batching; the batch runs through an EIP-7702 delegation on anvil
 * &rpc= the anvil RPC (default http://127.0.0.1:8545)
 */

// anvil default keys #2 (Aave looper, 60%) and #4 (Aave, 82%) — public test keys
const KEYS = {
  aave: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  hot: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} }

function useHarness(state: string, rpc: string): MigrateEnv | null {
  return useMemo(() => {
    if (state === 'demo') return null
    const chain = { ...anvil, rpcUrls: { default: { http: [rpc] } } }
    const key = state === 'trim' ? KEYS.hot : KEYS.aave
    const account = privateKeyToAccount(key)
    const base = {
      isDemo: false,
      connect: () => undefined,
      isWalletConnected: true,
      address: account.address,
    }
    if (state === 'wrong-chain') {
      return { ...base, chainId: 8453, chainLabel: 'Base', publicClient: undefined, walletClient: undefined }
    }
    if (state === 'mainnet') {
      return { ...base, chainId: 1, chainLabel: 'Ethereum', publicClient: undefined, walletClient: undefined }
    }
    return {
      ...base,
      chainId: 31337,
      chainLabel: 'Anvil (local)',
      publicClient: createPublicClient({ chain, transport: http(rpc) }) as PublicClient,
      walletClient: createWalletClient({ account, chain, transport: http(rpc) }),
      holdBeforeSimulate: state === 'ready',
      autoStart: state === 'settled' || state === 'batch-settled',
      atomic: state.startsWith('batch'),
      sendBatch: sendBatch7702(local.batchExecutor as `0x${string}`),
    }
  }, [state, rpc])
}

const DevMigrateSheet: React.FC = () => {
  const { query, isReady } = useRouter()
  const state = typeof query.state === 'string' ? query.state : 'demo'
  const sheet = query.sheet === 'deploy' ? 'deploy' : 'migrate'
  const rpc = typeof query.rpc === 'string' ? query.rpc : 'http://127.0.0.1:8545'
  const position = useMemo(() => demoBorrowerPosition(), [])
  const env = useHarness(state, rpc)
  if (!isReady) return null
  const Sheet = sheet === 'deploy' ? DeploySheet : MigrateSheet
  const body = <Sheet position={position} onClose={() => undefined} inline />
  return (
    <>
      <Head>
        <title>Dev · migrate sheet</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <Box bg={SEMANTIC_COLORS.bgPrimary} minH="100vh" px={SPACING.base} py={SPACING.lg}>
        <VStack spacing={SPACING.base} align="stretch" maxW="560px" mx="auto">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.28em" color={SEMANTIC_COLORS.textTertiary}>
            dev · {sheet} · {state}
          </Text>
          {env ? <MigrateHarness env={env}>{body}</MigrateHarness> : body}
        </VStack>
      </Box>
    </>
  )
}

export default DevMigrateSheet
