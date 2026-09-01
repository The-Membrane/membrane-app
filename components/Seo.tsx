import Head from 'next/head'
import { useRouter } from 'next/router'

/**
 * Server-rendered SEO tags (docs/SEO ruleset R3+R5). Rendered once in _app with
 * route-derived defaults; indexable pages render it again with specific copy —
 * next/head dedupes by `key`, and the page-level instance (deeper in the tree) wins.
 *
 * Canonical/og:url/og:image need an absolute origin, which only exists when
 * NEXT_PUBLIC_SITE_URL is set — until then those tags are omitted rather than
 * emitted with a wrong host.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '')

export const DEFAULT_DESCRIPTION =
  'Borrow the CDT stablecoin against crypto collateral with an 8-hour cure window before liquidation, earn on deposits, and route yield across venues on Membrane.'

export const DEFAULT_OG_IMAGE = '/og.png'

type SeoProps = {
  title?: string
  description?: string
  /** Canonical path override; defaults to the current route path without query/hash. */
  path?: string
  /** Absolute URL or site-relative path to a 1200x630 card. */
  image?: string
}

const Seo = ({ title, description = DEFAULT_DESCRIPTION, path, image = DEFAULT_OG_IMAGE }: SeoProps) => {
  const router = useRouter()
  const routePath = (path ?? router.asPath ?? '/').split(/[?#]/)[0]
  const canonical = SITE_URL ? `${SITE_URL}${routePath === '/' ? '' : routePath}` || SITE_URL : undefined
  const imageUrl = image.startsWith('http') ? image : SITE_URL ? `${SITE_URL}${image}` : undefined

  return (
    <Head>
      {title && <title key="title">{title}</title>}
      <meta key="description" name="description" content={description} />
      {canonical && <link key="canonical" rel="canonical" href={canonical} />}
      {title && <meta key="og:title" property="og:title" content={title} />}
      <meta key="og:description" property="og:description" content={description} />
      <meta key="og:type" property="og:type" content="website" />
      <meta key="og:site_name" property="og:site_name" content="Membrane" />
      {canonical && <meta key="og:url" property="og:url" content={canonical} />}
      {imageUrl && <meta key="og:image" property="og:image" content={imageUrl} />}
      <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
      {title && <meta key="twitter:title" name="twitter:title" content={title} />}
      <meta key="twitter:description" name="twitter:description" content={description} />
      {imageUrl && <meta key="twitter:image" name="twitter:image" content={imageUrl} />}
    </Head>
  )
}

export default Seo
