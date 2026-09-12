import type { GetServerSideProps } from 'next'
import { DEFAULT_CHAIN } from '@/config/chains'

// Server-side redirect: no client-side flash, correct 307 with working back button.
// Forward query params (especially ?ref=) through the redirect.
export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  // Owner ruling 2026-09-11: the position simulator IS the landing page — cold
  // traffic opens on a verdict and a paste box. Evidence stays one nav click away.
  const targetPath = `/${DEFAULT_CHAIN}/simulator`
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
