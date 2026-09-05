import type { GetServerSideProps } from 'next'
import { DEFAULT_CHAIN } from '@/config/chains'
import { SITE_URL } from '@/components/Seo'
import { getPostSlugs } from '@/helpers/blog'

/**
 * /sitemap.xml as an SSR route (SEO rule R4). Only lists pages that serve real
 * content — the root `/` is excluded because it currently redirects (R2), and a
 * sitemap entry that 3xx's is a soft error in Search Console.
 *
 * Keep in sync with the per-page <Seo> overrides and pages/robots.txt.tsx.
 */
const INDEXABLE_PATHS = [
  `/${DEFAULT_CHAIN}`,
  `/${DEFAULT_CHAIN}/borrow`,
  `/${DEFAULT_CHAIN}/home`,
  `/${DEFAULT_CHAIN}/landing`,
  `/${DEFAULT_CHAIN}/mint`,
  `/${DEFAULT_CHAIN}/stake`,
  `/${DEFAULT_CHAIN}/transmuter`,
  '/terms',
  '/blog',
]

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
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
