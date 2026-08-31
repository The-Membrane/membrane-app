import type { GetServerSideProps } from 'next'

import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

// The Evidence tool is the landing page and renders at /[chain]. This route is kept
// so existing links keep working, but it redirects rather than rendering a second
// copy — serving identical content at two URLs splits ranking signals and breaks the
// one-canonical-URL rule (docs/SEO_RULESET.md R1/R2). One hop only; never chained.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  const isValidChain = supportedChains.some((c) => c.name === chainName)

  return {
    redirect: {
      destination: `/${isValidChain ? chainName : DEFAULT_CHAIN}`,
      permanent: true,
    },
  }
}

export default function EvidenceRedirect() {
  return null
}
