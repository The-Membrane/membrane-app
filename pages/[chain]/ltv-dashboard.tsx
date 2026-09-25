import type { GetServerSideProps } from 'next'

// The LTV dashboard folded into the risk desk (docs/MOAT_TRACKER.md step 9).
// Old links land on /[chain]/risk; not permanent while the desk runs on a local chain.
export const getServerSideProps: GetServerSideProps = async (context) => {
  const chain = typeof context.params?.chain === 'string' ? context.params.chain : 'ethereum'
  return { redirect: { destination: `/${chain}/risk`, permanent: false } }
}

const LTVDashboardRedirect = () => null

export default LTVDashboardRedirect
