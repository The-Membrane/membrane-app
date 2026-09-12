import type { GetServerSideProps } from 'next'
import { DEFAULT_CHAIN } from '@/config/chains'
import { LANDING_SIM_MODE, SIM_ROUTE } from '@/config/simulatorMode'

// Server-side redirect: no client-side flash, correct 307 with working back button.
// Forward query params (especially ?ref=) through the redirect.
export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  // Owner ruling 2026-09-11: the position simulator IS the landing page — cold
  // traffic opens on a verdict and a paste box. Evidence stays one nav click away.
  // Owner ruling 2026-09-12: WHICH simulator is one constant, not a code change here.
  // Flip LANDING_SIM_MODE in config/simulatorMode.ts to go back to borrower-first.
  const targetPath = `/${DEFAULT_CHAIN}${SIM_ROUTE[LANDING_SIM_MODE]}`
  const params = new URLSearchParams(query as Record<string, string>).toString()
  const destination = params ? `${targetPath}?${params}` : targetPath

  return {
    redirect: {
      destination,
      permanent: false,
    },
  }
}

export default function Redirect() {
  return null
}
