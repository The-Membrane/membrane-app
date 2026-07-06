import theme from '@/theme'
import { ChakraProvider } from '@chakra-ui/react'
import type { AppProps } from 'next/app'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '@/config/evm/wagmi'
import { useEffect } from 'react'
import Layout from '@/components/Layout'

import { lazy } from 'react'
const ReactQueryDevtools = lazy(() =>
  import('@tanstack/react-query-devtools').then(m => ({ default: m.ReactQueryDevtools }))
)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // useErrorBoundary: true,
      staleTime: 300000, // 300 seconds
      gcTime: 1000 * 60 * 60 * 24, // 24 hours (renamed from cacheTime in React Query v5)
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  },
})

import '../styles/global.css';
import useAppState from '@/persisted-state/useAppState'
import Head from 'next/head'
import { usePageTitle } from '@/hooks/usePageTitle'
import { DEFAULT_CHAIN, getChainConfig } from '@/config/chains'
import { rpcUrl } from '@/config/defaults'
import { usePerformanceMetrics } from '@/hooks/usePerformanceMetrics'
import { useAffiliateCaptureFromUrl } from '@/hooks/useAffiliate'

const App = ({ Component, pageProps }: AppProps) => {
  const pageTitle = usePageTitle()

  // Measure performance metrics
  usePerformanceMetrics(true)

  // Capture ?ref= affiliate param from URL
  useAffiliateCaptureFromUrl()

  const { appState, setAppState } = useAppState()
  // Legacy Cosmos read-path default (appState.rpcUrl feeds useCosmWasmClient) — kept
  // until the service layer finishes migrating to services/chain (EVM). See
  // docs/EVM_MIGRATION.md.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const defaultChainConfig = getChainConfig(DEFAULT_CHAIN)
    const currentRpcUrl = appState?.rpcUrl
    if (currentRpcUrl === undefined || currentRpcUrl === rpcUrl) {
      if (currentRpcUrl !== defaultChainConfig.rpcUrl) {
        setAppState({ rpcUrl: defaultChainConfig.rpcUrl });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState?.rpcUrl])

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Head>
          <title>{pageTitle}</title>
        </Head>
        <ChakraProvider resetCSS theme={theme}>
          <Layout>
            <Component {...pageProps} />
          </Layout>
        </ChakraProvider>
        {process.env.NODE_ENV === 'development' && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
