import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { supportedChains } from '@/config/chains'
import { useChainRoute } from '@/hooks/useChainRoute'

interface ChainLayoutProps {
    children: React.ReactNode
}

export default function ChainLayout({ children }: ChainLayoutProps) {
    const router = useRouter()
    const { chainName, isValidChain } = useChainRoute()

    useEffect(() => {
        if (!isValidChain) {
            const pathWithoutLeadingChain = router.asPath.replace(/^\/[^/]+/, '')
            router.replace(`/${supportedChains[0].name}${pathWithoutLeadingChain}`)
        }
    }, [chainName, isValidChain, router])

    if (!isValidChain) {
        return null
    }

    return <>{children}</>
} 