import type { GetServerSideProps } from 'next'
import { DEFAULT_CHAIN, supportedChains } from '@/config/chains'

// One carry destination. Preserve old strategy links as a direct jump to the
// tracked-books portion of the unified board.
export const getServerSideProps: GetServerSideProps = async ({ params }) => {
  const requested = typeof params?.chain === 'string' ? params.chain : DEFAULT_CHAIN
  const chain = supportedChains.some((item) => item.name === requested) ? requested : DEFAULT_CHAIN
  return { redirect: { destination: `/${chain}/carry#strats`, permanent: false } }
}

export default function StratsRedirect() {
  return null
}
