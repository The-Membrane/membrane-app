import type { GetServerSideProps } from 'next'
import { SITE_URL } from '@/components/Seo'

/**
 * /robots.txt as an SSR text route (SEO rule R4) instead of a static file:
 * the Sitemap directive requires an absolute URL, which comes from
 * NEXT_PUBLIC_SITE_URL (falling back to the request host).
 *
 * Disallowed paths are app-only/experimental surfaces we don't want indexed —
 * keep this list in sync with the indexable set in pages/sitemap.xml.tsx.
 */
export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const origin = SITE_URL || `https://${req.headers.host}`
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /management',
    'Disallow: /nft',
    'Disallow: /lockdrop',
    'Disallow: /tournament',
    'Disallow: /proto/',
    'Disallow: /sensory/',
    'Disallow: /*/acquisition-sim',
    'Disallow: /*/acquisition-dashboard',
    'Disallow: /*/control-room',
    'Disallow: /*/maze-runners',
    'Disallow: /*/ltv-dashboard',
    'Disallow: /*/membrane-dashboard',
    'Disallow: /*/tournament',
    // about is internal until its placeholder copy is replaced with real
    // company facts (docs/GEO_AUDIT.md trust-anchor finding); levels is a sim.
    'Disallow: /*/about',
    'Disallow: /*/levels',
    // /manic entries removed: the route was deleted on this branch and now
    // returns a real 404 via middleware.ts — disallowing a 404 is noise.
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.write(body)
  res.end()
  return { props: {} }
}

// Never rendered — getServerSideProps ends the response.
export default function Robots() {
  return null
}
