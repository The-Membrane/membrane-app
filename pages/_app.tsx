import theme from '@/theme'
import { ChakraProvider } from '@chakra-ui/react'
import type { AppProps } from 'next/app'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '@/config/evm/wagmi'
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
      // EVM data is bigint-laden and some hooks key queries on it; JSON.stringify
      // throws "Do not know how to serialize a BigInt" and crashes the page. Hash
      // bigints explicitly (suffix disambiguates 1n from "1").
      queryKeyHashFn: (key) =>
        JSON.stringify(key, (_, v) => (typeof v === 'bigint' ? `${v.toString()}#bigint` : v)),
    },
  },
})

import '../styles/global.css';
import Head from 'next/head'
import { usePageTitle } from '@/hooks/usePageTitle'
import { usePerformanceMetrics } from '@/hooks/usePerformanceMetrics'
import { useAffiliateCaptureFromUrl } from '@/hooks/useAffiliate'

const App = ({ Component, pageProps }: AppProps) => {
  const pageTitle = usePageTitle()

  // Measure performance metrics
  usePerformanceMetrics(true)

  // Capture ?ref= affiliate param from URL
  useAffiliateCaptureFromUrl()

  // NOTE: the legacy Cosmos rpcUrl-defaulting effect that lived here is GONE — it
  // ping-ponged appState.rpcUrl against HorizontalNav's route-sync effect (osmosis
  // default vs DEFAULT_CHAIN), overflowing React's update depth (#185) in production.
  // appState.rpcUrl only feeds dead Cosmos read paths now; HorizontalNav remains the
  // single writer until those paths are deleted at cutover.

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
