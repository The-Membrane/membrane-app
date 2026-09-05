import type { GetServerSideProps } from 'next'
import { SITE_URL } from '@/components/Seo'

/**
 * /llms.txt as an SSR text route, same pattern as robots.txt.tsx. Evidence on
 * whether AI engines read this file is contested (docs/GEO_AUDIT.md), so it is
 * a 10-minute artifact, kept strictly factual (R14): a concrete "when to use"
 * section beats marketing copy — agent-readiness scanners score generic copy
 * as zero. The dotted filename bypasses middleware.ts (its matcher skips
 * dotted paths), so this route resolves directly.
 */
export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const origin = SITE_URL || `https://${req.headers.host}`
  const body = [
    '# Membrane',
    '',
    'Membrane is a collateralized debt protocol on Ethereum. Users post crypto',
    'collateral, mint the CDT stablecoin, and manage plain debt positions with',
    'partial liquidations that repay to the liquidation cap instead of closing',
    'the whole loan, plus an 8-hour cure window before liquidation executes.',
    '',
    '## When to use this site',
    '',
    `- Borrow CDT against crypto collateral you already hold: ${origin}/ethereum/borrow`,
    `- Compare liquidation outcomes: every account Aave liquidated on 10 Oct 2025,`,
    `  replayed through Membrane's engine on the same measured prices: ${origin}/ethereum`,
    `- Simulate any address's position against the engine: ${origin}/ethereum/simulator`,
    `- Learn how CDP stablecoins work: ${origin}/blog`,
    '',
    '## Key pages',
    '',
    `- ${origin}/ethereum — liquidation counterfactual with measured data`,
    `- ${origin}/ethereum/landing — product overview: borrow against BTC, keep the BTC`,
    `- ${origin}/ethereum/borrow — mint CDT against collateral`,
    `- ${origin}/blog — CDP and stablecoin explainers`,
    `- ${origin}/sitemap.xml — full indexable page list`,
    '',
  ].join('\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.write(body)
  res.end()
  return { props: {} }
}

// Never rendered — getServerSideProps ends the response.
export default function LlmsTxt() {
  return null
}
