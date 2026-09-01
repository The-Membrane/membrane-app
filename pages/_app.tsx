import theme from '@/theme'
import { ChakraProvider } from '@chakra-ui/react'
import type { AppProps } from 'next/app'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '@/config/evm/wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import Layout from '@/components/Layout'
import { MotionConfig, LazyMotion } from 'framer-motion'
import { Inter } from 'next/font/google'

// Self-hosted Inter via next/font (replaces the render-blocking Google Fonts <link>).
// Inter is a variable font, so all weights 400–700 are covered without listing them.
// Exposed as the CSS variable --font-inter; the global style below maps it onto :root so
// EVERYTHING — including Chakra Modals/Tooltips that portal to document.body outside any
// wrapper — resolves the same font. theme/fonts.ts and every `fontFamily="var(--font-inter)"`
// call site read this variable.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' })

// Lazy-load framer-motion's DOM feature bundle so it's code-split out of the initial JS
// payload — this is what `use-lazy-motion` is about. Components using `m` (instead of the
// heavy `motion`) stay lightweight until features resolve. `domMax` covers animations +
// layout + drag, so no converted component loses a feature. strict={false} lets any
// not-yet-migrated `motion` usage keep working during the gradual migration.
const loadMotionFeatures = () => import('framer-motion').then((mod) => mod.domMax)

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

import '../styles/fonts.css';
import '../styles/global.css';
import Seo from '@/components/Seo'
import { usePageTitle } from '@/hooks/usePageTitle'
import { usePerformanceMetrics } from '@/hooks/usePerformanceMetrics'
import { useAffiliateCaptureFromUrl } from '@/hooks/useAffiliate'
import { useSessionHeartbeat } from '@/hooks/useSessionHeartbeat'

const App = ({ Component, pageProps }: AppProps) => {
  const pageTitle = usePageTitle()

  // Measure performance metrics
  usePerformanceMetrics(true)

  // Capture ?ref= affiliate param from URL
  useAffiliateCaptureFromUrl()

  // Phase 5 (docs/OFFCHAIN_QRACING_PLAN.md): server-side session tracking, best-effort.
  useSessionHeartbeat()

  // NOTE: the legacy Cosmos rpcUrl-defaulting effect that lived here is GONE — it
  // ping-ponged appState.rpcUrl against HorizontalNav's route-sync effect (osmosis
  // default vs DEFAULT_CHAIN), overflowing React's update depth (#185) in production.
  // appState.rpcUrl only feeds dead Cosmos read paths now; HorizontalNav remains the
  // single writer until those paths are deleted at cutover.

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme({ accentColor: '#9bdc4f' })}>
          {/* Sitewide SEO defaults (route-derived title, default description/OG).
              Indexable pages render their own <Seo> with specific copy — it wins
              because next/head dedupes by key and the deeper instance is last. */}
          <Seo title={pageTitle} />
          {/* Map the next/font-generated family onto :root so it reaches body-portaled
              Chakra Modals/Tooltips (which render outside any wrapper element). */}
          <style jsx global>{`:root { --font-inter: ${inter.style.fontFamily}; }`}</style>
          {/* Respect the OS "reduce motion" setting for all framer-motion animations
              (WCAG 2.3.3) — transform/opacity still animate, layout-shifting motion is reduced. */}
          <MotionConfig reducedMotion="user">
            <LazyMotion features={loadMotionFeatures} strict={false}>
              <ChakraProvider resetCSS theme={theme}>
                <Layout>
                  <Component {...pageProps} />
                </Layout>
              </ChakraProvider>
            </LazyMotion>
          </MotionConfig>
          {process.env.NODE_ENV === 'development' && <ReactQueryDevtools initialIsOpen={false} />}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
