import { useRouter } from 'next/router'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'

export const useChainRoute = () => {
    const router = useRouter()
    const { chain } = router.query

    // If no chain in route, default to DEFAULT_CHAIN (neutron)
    const chainName = typeof chain === 'string' ? chain : DEFAULT_CHAIN

    // Validate chain is supported
    const isValidChain = supportedChains.some(c => c.name === chainName)

    return {
        chainName: isValidChain ? chainName : DEFAULT_CHAIN,
        isValidChain
    }
} 