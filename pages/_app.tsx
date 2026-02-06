import theme from '@/theme'
import { ChakraProvider } from '@chakra-ui/react'
import type { AppProps } from 'next/app'
import { SignerOptions } from '@cosmos-kit/core'
import { ChainProvider } from '@cosmos-kit/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { assets, chains } from 'chain-registry'
import { wallets as cosmostationWallets } from '@cosmos-kit/cosmostation'
import { wallets as keplrWallets } from '@cosmos-kit/keplr'
import { wallets as keplrMobile } from '@cosmos-kit/keplr-mobile'
import { wallets as leapWallets } from '@cosmos-kit/leap'
import { wallets as leapMobile } from '@cosmos-kit/leap-mobile'
import { wallets as ledgerWallets } from '@cosmos-kit/ledger'
import { wallets as stationWallets } from '@cosmos-kit/station'
import { wallets as tailwindWallets } from '@cosmos-kit/tailwind'
import { Chain } from '@chain-registry/types'
import WalletModal from '@/components/WalletModal'
import { aminoTypes, registry, rpcUrl } from '@/config/defaults'
import { useEffect } from 'react'
import Layout from '@/components/Layout'
import { getGasConfig } from '@/config/gas'

import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
//pnpm install @cosmos-kit/keplr-mobile@^2.4.3
// import '@interchain-ui/react/styles'
// import MembersRules from '@/components/MembersRules'

const signerOptions: SignerOptions = {
  signingStargate: () => {
    return {
      aminoTypes,
      registry,
      gasPrice: GasPrice.fromString('0.01uosmo'),
    }
  },
  signingCosmwasm: (chain: string | Chain) => {
    const chainName = typeof chain === 'string' ? chain : chain.chain_name;
    const gasConfig = getGasConfig(chainName);

    if (gasConfig) {
      return {
        gasPrice: GasPrice.fromString(`${gasConfig.gasPrice}${gasConfig.denom}`),
        ...(gasConfig.gasLimit && { gas: gasConfig.gasLimit }),
      }
    }

    return undefined;
  },
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // useErrorBoundary: true,
      staleTime: 300000, // 300 seconds
      cacheTime: 1000 * 60 * 60 * 24, // 24 hours
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  },
})

import '../styles/global.css';
import { GasPrice } from '@cosmjs/stargate'
import useAppState from '@/persisted-state/useAppState'
import Head from 'next/head'
import { usePageTitle } from '@/hooks/usePageTitle'
import { DEFAULT_CHAIN, getChainConfig } from '@/config/chains'
import { usePerformanceMetrics } from '@/hooks/usePerformanceMetrics'

const App = ({ Component, pageProps }: AppProps) => {
  const pageTitle = usePageTitle()
  
  // Measure performance metrics
  usePerformanceMetrics(true)

  const { appState, setAppState } = useAppState()
  // Default to neutron chain RPC if not already set or if it's still the default osmosis RPC
  useEffect(() => {
    if (typeof window === 'undefined') return
    const defaultChainConfig = getChainConfig(DEFAULT_CHAIN)
    const currentRpcUrl = appState?.rpcUrl
    // Only update if we need to (undefined or still using default osmosis RPC)
    if (currentRpcUrl === undefined || currentRpcUrl === rpcUrl) {
      // Only set if the new value is different to prevent infinite loops
      if (currentRpcUrl !== defaultChainConfig.rpcUrl) {
        setAppState({ rpcUrl: defaultChainConfig.rpcUrl });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState?.rpcUrl])

  return (
    <QueryClientProvider client={queryClient}>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      <ChakraProvider resetCSS theme={theme}>
        <ChainProvider
          sessionOptions={{
            duration: 1000 * 60 * 60 * 24 * 7, // 7 days
          }}
          allowedIframeParentOrigins={['http://daodao.zone', 'https://tabcoin.zone']}
          chains={chains}
          assetLists={assets}
          wallets={[
            ...keplrWallets?.slice(0, 1),
            ...cosmostationWallets?.slice(0, 1),
            ...ledgerWallets?.slice(0, 1),
            ...leapWallets?.slice(0, 1),
            ...stationWallets?.slice(0, 1),
            ...tailwindWallets?.slice(0, 1),
            // Mobile wallets disabled to prevent walletconnectOptions errors
            // ...keplrMobile?.slice(0, 1),
            // ...leapMobile?.slice(0, 1),
          ]}
          walletModal={WalletModal}
          signerOptions={signerOptions}
          endpointOptions={{
            isLazy: true,
            endpoints: {
              osmosis: {
                rpc: ['https://osmosis-rpc.polkachu.com/'],
              },
              neutron: {
                rpc: ['https://rpc-celatone.neutron-1.neutron.org'],
              },
            },
          }}
        >
          <Layout>
            <Component {...pageProps} />
          </Layout>
        </ChainProvider>
      </ChakraProvider>
      {process.env.NODE_ENV === 'development' && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  )
}

export default App
