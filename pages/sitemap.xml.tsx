import type { GetServerSideProps } from 'next'
import { DEFAULT_CHAIN } from '@/config/chains'
import { getPostSlugs } from '@/helpers/blog'
import { SIM_ROUTE } from '@/config/simulatorMode'

/**
 * /sitemap.xml as an SSR route (SEO rule R4). Only lists pages that serve real
 * content — the root `/` is excluded because it currently redirects (R2), and a
 * sitemap entry that 3xx's is a soft error in Search Console.
 *
 * Keep in sync with the per-page <Seo> overrides and pages/robots.txt.tsx.
 */
export const INDEXABLE_PATHS = [
  `/${DEFAULT_CHAIN}`,
  `/${DEFAULT_CHAIN}/borrow`,
  `/${DEFAULT_CHAIN}/carry`,
  `/${DEFAULT_CHAIN}/home`,
  `/${DEFAULT_CHAIN}/landing`,
  `/${DEFAULT_CHAIN}/mint`,
  // BOTH simulator builds are indexable (pages/[chain]/simulator.tsx and
  // pages/[chain]/carry-simulator.tsx) and both are demo-first conversion surfaces.
  // Only one of them is the landing page — see config/simulatorMode.ts — but the
  // other is a real page with its own worked example, not a redirect.
  `/${DEFAULT_CHAIN}${SIM_ROUTE.borrower}`,
  `/${DEFAULT_CHAIN}${SIM_ROUTE.carry}`,
  `/${DEFAULT_CHAIN}/stake`,
  `/${DEFAULT_CHAIN}/transmuter`,
  // Venue permalinks — the D3 landings, content-rich and provenance-stamped.
  `/${DEFAULT_CHAIN}/venue/sUSDe`,
  `/${DEFAULT_CHAIN}/venue/sUSDS`,
  `/${DEFAULT_CHAIN}/venue/scrvUSD`,
  `/${DEFAULT_CHAIN}/venue/aave-v3-usde`,
  '/terms',
  '/blog',
]

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  // Imported here rather than at module scope so INDEXABLE_PATHS can be read by a
  // plain unit test without dragging components/Seo.tsx (and all of JSX) in with it.
  const { SITE_URL } = await import('@/components/Seo')
  const origin = SITE_URL || `https://${req.headers.host}`
  const paths = [...INDEXABLE_PATHS, ...getPostSlugs().map((slug) => `/blog/${slug}`)]
  const urls = paths.map(
    (path) => `  <url><loc>${origin}${path}</loc></url>`,
  ).join('\n')
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`

  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.write(body)
  res.end()
  return { props: {} }
}

// Never rendered — getServerSideProps ends the response.
export default function Sitemap() {
  return null
}
