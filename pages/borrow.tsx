import type { GetServerSideProps } from 'next'
import { supportedChains } from '@/config/chains'

// Server-side redirect: no client-side flash, correct 307 with working back button.
export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: `/${supportedChains[0].name}/borrow`,
      permanent: false,
    },
  }
}

export default function Redirect() {
  return null
}
