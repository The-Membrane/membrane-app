import React from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'

/**
 * /proto/[page] — frames the design prototypes in public/proto/ as reachable routes
 * so the UI-sensory layer can audit them (tools/ui-sensory/*). The prototypes are
 * self-contained HTML with embedded mock data: no wallet, no RPC, no anvil needed.
 *
 * These are design targets, not product code. The landing prototype's wallet-connect
 * is the one exception — it calls the injected provider if present.
 *
 * getServerSideProps is load-bearing beyond validation: without it this page is
 * auto-statically optimized, lands in the dev isrManifest, and Next 15.5's
 * hot-reloader throws in handleStaticIndicator ("reading 'components'") on every
 * HMR message, killing hydration for the route. Server-rendering opts us out.
 */
const PAGES = ['dash', 'builder', 'borrow', 'carry', 'supply', 'defend', 'flow', 'landing', 'demo'] as const
type ProtoPage = (typeof PAGES)[number]

const TITLES: Record<ProtoPage, string> = {
  dash: 'Position',
  builder: 'Builder',
  borrow: 'Borrow',
  carry: 'Carry',
  supply: 'Earn',
  defend: 'Defend',
  flow: 'Nav Flow',
  landing: 'Landing',
  demo: 'Demo position',
}

export const getServerSideProps: GetServerSideProps<{ page: ProtoPage }> = async (ctx) => {
  const raw = ctx.params?.page
  const page = typeof raw === 'string' && (PAGES as readonly string[]).includes(raw)
    ? (raw as ProtoPage)
    : null
  if (!page) return { notFound: true }
  return { props: { page } }
}

const ProtoPageRoute = ({ page }: { page: ProtoPage }) => {
  // Forward the outer hash (e.g. /proto/dash#demo) into the iframe: hashes never
  // reach the server and don't propagate into a fixed src, so without this the
  // prototypes' hash-gated modes (demo mode) only work via in-iframe navigation.
  const [hash, setHash] = React.useState('')
  React.useEffect(() => {
    setHash(window.location.hash)
  }, [])
  return (
    <>
      <Head>
        <title>{`Proto — ${TITLES[page]} | Membrane`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <iframe
        src={`/proto/${page}.html${hash}`}
        title={`Prototype: ${TITLES[page]}`}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    </>
  )
}

export default ProtoPageRoute
