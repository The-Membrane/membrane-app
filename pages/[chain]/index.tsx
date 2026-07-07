import Home from '@/components/Home/Home'
import React, { useEffect } from 'react'
import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import { useChainRoute } from '@/hooks/useChainRoute'
import { Box, Text, VStack } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'

const NeutronHome = dynamic(() => import('@/components/NeutronHome').then(m => m.default || m.NeutronHome), { ssr: false })

// Base home page for non-neutron chains
const BaseHome = () => {
    return (
        <Box minH="100vh" bg="#091326" display="flex" alignItems="center" justifyContent="center">
            <VStack spacing={4}>
                <Text fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold} color="white">Membrane Protocol</Text>
                <Text fontSize="md" color="gray.400">Welcome to the Membrane</Text>
            </VStack>
        </Box>
    )
}

const IndexPage = () => {
    // EVM-only: a single chain path (/ethereum). Stale bookmarks (/osmosis, /neutron)
    // land here with an invalid chain — rewrite the URL, then render the one Home.
    const { chainName, isValidChain } = useChainRoute()
    const router = useRouter()
    useEffect(() => {
        if (router.isReady && !isValidChain) {
            router.replace(`/${chainName}`)
        }
    }, [router.isReady, isValidChain, chainName])

    return <Home />
}

export default IndexPage
