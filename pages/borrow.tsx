import { useEffect } from 'react'
import { useRouter } from 'next/router'
import { supportedChains } from '@/config/chains'

export default function Redirect() {
  const router = useRouter()
  
  useEffect(() => {
    router.replace(`/${supportedChains[0].name}/borrow`)
  }, [router])

  return null
}
