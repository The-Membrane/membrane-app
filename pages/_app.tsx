import theme from '@/theme'
import { ChakraProvider } from '@chakra-ui/react'
import type { AppProps } from 'next/app'
import { SignerOptions } from '@cosmos-kit/core'
import { ChainProvider } from '@cosmos-kit/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { assets, chains } from 'chain-registry'
import { GasPrice } from 'cosmwasm'
import { wallets as cosmostationWallets } from '@cosmos-kit/cosmostation'
import { wallets as keplrWallets } from '@cosmos-kit/keplr'
import { wallets as leapWallets } from '@cosmos-kit/leap'
import { wallets as ledgerWallets } from '@cosmos-kit/ledger'
import { wallets as stationWallets } from '@cosmos-kit/station'
import { wallets as tailwindWallets } from '@cosmos-kit/tailwind'
import { Chain } from '@chain-registry/types'
import WalletModal from '@/components/WalletModal'
import { aminoTypes, registry, rpcUrl } from '@/config/defaults'
import { useEffect, useState } from 'react'
import Layout from '@/components/Layout'
// import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

import '@interchain-ui/react/styles'
// import MembersRules from '@/components/MembersRules'

const signerOptions: SignerOptions = {
  signingStargate: () => {
    return {
      aminoTypes,
      registry,
      gasPrice: GasPrice.fromString('0.0075uosmo'),
    }
  },
  signingCosmwasm: (chain: Chain) => {
    switch (chain.chain_name) {
      case 'osmosis':
      case 'osmosistestnet5':
        return {
          gasPrice: GasPrice.fromString('0.0075uosmo'),
        }
    }
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

const App = ({ Component, pageProps }: AppProps) => {
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    setIsLoaded(true)
  }, [])

  if (!isLoaded) return null

  return (
    <QueryClientProvider client={queryClient}>
      <ChakraProvider resetCSS theme={theme}>
        <ChainProvider
          sessionOptions={{
            duration: 1000 * 60 * 60 * 24 * 7, // 7 days
          }}
          chains={chains}
          assetLists={assets}
          wallets={[
            ...keplrWallets?.slice(0, 1),
            ...cosmostationWallets?.slice(0, 1),
            ...ledgerWallets?.slice(0, 1),
            ...leapWallets?.slice(0, 1),
            ...stationWallets?.slice(0, 1),
            ...tailwindWallets?.slice(0, 1),
          ]}
          walletModal={WalletModal}
          signerOptions={signerOptions}
          endpointOptions={{
            isLazy: true,
            endpoints: {
              osmosis: {
                rpc: [rpcUrl],
              },
            },
          }}
        >
          <Layout>
            <Component {...pageProps} />
          </Layout>
        </ChainProvider>
      </ChakraProvider>
      {/* <ReactQueryDevtools initialIsOpen={false} /> */}
    </QueryClientProvider>
  )
}

export default App
