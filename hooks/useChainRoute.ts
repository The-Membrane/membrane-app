import { useRouter } from 'next/router'
import { supportedChains } from '@/config/chains'

export const useChainRoute = () => {
    const router = useRouter()
    const { chain } = router.query

    // If no chain in route, default to first supported chain
    const chainName = typeof chain === 'string' ? chain : supportedChains[0].name

    // Validate chain is supported
    const isValidChain = supportedChains.some(c => c.name === chainName)

    return {
        chainName: isValidChain ? chainName : supportedChains[0].name,
        isValidChain
    }
} 