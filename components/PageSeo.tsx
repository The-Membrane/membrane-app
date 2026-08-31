import React from 'react'
import Head from 'next/head'

import Seo from '@/components/Seo'

/**
 * docs/SEO_RULESET.md Rule 0 — every page declares an SEO class:
 * - indexable: marketing/entry pages a stranger should find (search/shared link) — indexed
 * - app: wallet-gated tools, useful only to existing users — noindex,follow
 * - internal: experiments/sims/event pages — noindex,nofollow
 */
export type SeoClass = 'indexable' | 'app' | 'internal'

export interface PageSeoProps {
  seoClass: SeoClass
  title?: string
  description?: string
  /** Canonical path override; defaults to the current route path without query/hash. */
  path?: string
  /** Absolute URL or site-relative path to a 1200x630 card. */
  image?: string
}

/**
 * SEO-class-aware wrapper over Seo (docs/SEO_RULESET.md Rule 0). Meant to be
 * every page's first JSX child. `indexable` pages render Seo unchanged so
 * they stay crawlable; `app` and `internal` pages additionally emit
 * `noindex,nofollow` — per R6, robots.txt alone is not enough to keep a
 * disallowed-but-linked page out of the index.
 */
export const PageSeo: React.FC<PageSeoProps> = ({ seoClass, title, description, path, image }) => (
  <>
    <Seo title={title} description={description} path={path} image={image} />
    {seoClass !== 'indexable' && (
      <Head>
        <meta key="robots" name="robots" content="noindex,nofollow" />
      </Head>
    )}
  </>
)

export default PageSeo
